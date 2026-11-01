from datetime import datetime, timezone
from pathlib import PurePath
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, Query
from botocore.exceptions import ClientError
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..config import settings
from ..database import get_db
from ..models import StoredFile, User
from ..schemas import PresignRequest, PresignResponse, RestoreRequest
from ..security import get_current_user
from ..services import s3_service
from ..services.s3_service import StorageNotReady

router = APIRouter(prefix="/api/files", tags=["Files"])

def owned_file(file_id: str, user: User, db: Session) -> StoredFile:
    item = db.scalar(select(StoredFile).where(StoredFile.id == file_id, StoredFile.owner_id == user.id))
    if item is None:
        raise HTTPException(status_code=404, detail="File not found")
    return item

@router.get("")
def list_files(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(StoredFile).where(StoredFile.owner_id == user.id).order_by(StoredFile.updated_at.desc())).all()
    return [{
        "id": row.id,
        "filename": row.filename,
        "content_type": row.content_type,
        "size_bytes": row.size_bytes,
        "status": row.status,
        "deleted": row.deleted_at is not None,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "latest_version_id": row.latest_version_id,
    } for row in rows]

@router.post("/presign", response_model=PresignResponse)
def presign_upload(payload: PresignRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.size_bytes > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB upload limit")
    filename = PurePath(payload.filename.replace("\\", "/")).name.strip()
    if not filename or filename in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid filename")
    try:
        s3_service.ensure_versioning_enabled()
    except StorageNotReady as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if payload.existing_file_id:
        row = owned_file(payload.existing_file_id, user, db)
        if row.deleted_at is not None:
            raise HTTPException(status_code=409, detail="Restore the file before uploading a new version")
        file_id = row.id
        object_key = row.object_key
        content_type = payload.content_type or row.content_type
    else:
        file_id = str(uuid4())
        object_key = f"users/{user.id}/{file_id}/{filename}"
        content_type = payload.content_type or "application/octet-stream"
        row = StoredFile(id=file_id, owner_id=user.id, filename=filename, object_key=object_key, content_type=content_type, size_bytes=payload.size_bytes, status="pending")
        db.add(row)
        db.commit()
    try:
        url = s3_service.create_upload_url(object_key, content_type)
    except ClientError as exc:
        raise HTTPException(status_code=502, detail="Could not create an S3 upload URL") from exc
    return PresignResponse(file_id=file_id, upload_url=url, object_key=object_key, expires_in=300)

@router.post("/{file_id}/complete")
def complete_upload(file_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned_file(file_id, user, db)
    try:
        result = s3_service.head_object(row.object_key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"404", "NoSuchKey", "NotFound"}:
            raise HTTPException(status_code=409, detail="S3 object not found. Upload may not have completed.")
        raise HTTPException(status_code=502, detail="Could not verify the uploaded object") from exc
    actual_size = int(result.get("ContentLength", 0))
    if actual_size > settings.max_upload_bytes:
        version_id = result.get("VersionId")
        try:
            if version_id:
                s3_service.delete_specific_version(row.object_key, version_id)
            else:
                s3_service.delete_object(row.object_key)
        except ClientError:
            # The upload is rejected either way; an operator should inspect S3 if cleanup fails.
            pass
        if row.status == "pending":
            db.delete(row)
        db.commit()
        raise HTTPException(status_code=413, detail="Uploaded object exceeds the configured upload limit")
    row.size_bytes = actual_size
    row.latest_version_id = result.get("VersionId")
    row.content_type = result.get("ContentType", row.content_type)
    row.status = "ready"
    row.deleted_at = None
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Upload verified", "file_id": row.id, "size_bytes": row.size_bytes, "version_id": row.latest_version_id}

@router.get("/{file_id}/versions")
def get_versions(file_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned_file(file_id, user, db)
    try:
        versions = s3_service.list_versions(row.object_key)
    except ClientError as exc:
        raise HTTPException(status_code=502, detail="Could not retrieve S3 version history") from exc
    return {"file_id": file_id, "filename": row.filename, "versions": versions}

@router.get("/{file_id}/download")
def download_file(file_id: str, version_id: str | None = Query(default=None), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned_file(file_id, user, db)
    if row.deleted_at is not None and not version_id:
        raise HTTPException(status_code=410, detail="This file is deleted. Select an earlier version to restore it first.")
    if version_id:
        versions = s3_service.list_versions(row.object_key)
        allowed = any(item.get("version_id") == version_id and item.get("kind") == "version" for item in versions)
        if not allowed:
            raise HTTPException(status_code=404, detail="Version not found")
    try:
        url = s3_service.create_download_url(row.object_key, row.filename, version_id)
    except ClientError as exc:
        raise HTTPException(status_code=502, detail="Could not create download URL") from exc
    return {"download_url": url, "expires_in": 300}

@router.post("/{file_id}/restore")
def restore_file_version(file_id: str, payload: RestoreRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned_file(file_id, user, db)
    versions = s3_service.list_versions(row.object_key)
    allowed = any(item.get("version_id") == payload.version_id and item.get("kind") == "version" for item in versions)
    if not allowed:
        raise HTTPException(status_code=404, detail="The requested object version was not found")
    try:
        result = s3_service.restore_version(row.object_key, payload.version_id)
        head = s3_service.head_object(row.object_key)
    except ClientError as exc:
        raise HTTPException(status_code=502, detail="Could not restore this version") from exc
    row.latest_version_id = head.get("VersionId") or result.get("VersionId")
    row.size_bytes = int(head.get("ContentLength", row.size_bytes))
    row.deleted_at = None
    row.status = "ready"
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Version restored as a new latest S3 version", "new_version_id": row.latest_version_id}

@router.delete("/{file_id}")
def delete_file(file_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned_file(file_id, user, db)
    if row.deleted_at is None:
        try:
            s3_service.delete_object(row.object_key)
        except ClientError as exc:
            raise HTTPException(status_code=502, detail="Could not delete object") from exc
        row.deleted_at = datetime.now(timezone.utc)
        row.status = "deleted"
        db.commit()
    return {"message": "File deleted. S3 keeps older versions until they are explicitly removed."}
