import boto3
from botocore.exceptions import ClientError
from ..config import settings

s3 = boto3.client("s3", region_name=settings.aws_region)
BUCKET = settings.s3_bucket_name

class StorageNotReady(RuntimeError):
    pass

def ensure_versioning_enabled() -> None:
    try:
        result = s3.get_bucket_versioning(Bucket=BUCKET)
    except ClientError as exc:
        raise StorageNotReady(f"Cannot read S3 bucket versioning: {exc.response.get('Error', {}).get('Code', 'AWS error')}") from exc
    if result.get("Status") != "Enabled":
        raise StorageNotReady("S3 bucket versioning is not enabled. Enable it in the S3 bucket Properties tab.")

def create_upload_url(object_key: str, content_type: str) -> str:
    return s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": object_key, "ContentType": content_type},
        ExpiresIn=300,
    )

def head_object(object_key: str) -> dict:
    return s3.head_object(Bucket=BUCKET, Key=object_key)

def list_versions(object_key: str) -> list[dict]:
    paginator = s3.get_paginator("list_object_versions")
    items: list[dict] = []
    for page in paginator.paginate(Bucket=BUCKET, Prefix=object_key):
        for item in page.get("Versions", []):
            if item.get("Key") == object_key:
                items.append({
                    "version_id": item.get("VersionId"),
                    "is_latest": bool(item.get("IsLatest")),
                    "size_bytes": item.get("Size", 0),
                    "last_modified": item["LastModified"].isoformat(),
                    "kind": "version",
                })
        for item in page.get("DeleteMarkers", []):
            if item.get("Key") == object_key:
                items.append({
                    "version_id": item.get("VersionId"),
                    "is_latest": bool(item.get("IsLatest")),
                    "last_modified": item["LastModified"].isoformat(),
                    "kind": "delete_marker",
                })
    items.sort(key=lambda item: item["last_modified"], reverse=True)
    return items

def create_download_url(object_key: str, filename: str, version_id: str | None = None) -> str:
    params = {"Bucket": BUCKET, "Key": object_key, "ResponseContentDisposition": f'attachment; filename="{filename.replace(chr(34), "")}"'}
    if version_id:
        params["VersionId"] = version_id
    return s3.generate_presigned_url("get_object", Params=params, ExpiresIn=300)

def delete_object(object_key: str) -> dict:
    return s3.delete_object(Bucket=BUCKET, Key=object_key)

def restore_version(object_key: str, version_id: str) -> dict:
    return s3.copy_object(
        Bucket=BUCKET,
        Key=object_key,
        CopySource={"Bucket": BUCKET, "Key": object_key, "VersionId": version_id},
        MetadataDirective="COPY",
    )


def delete_specific_version(object_key: str, version_id: str) -> None:
    s3.delete_object(Bucket=BUCKET, Key=object_key, VersionId=version_id)
