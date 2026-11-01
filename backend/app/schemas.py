from pydantic import BaseModel, EmailStr, Field
from typing import Literal

class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)

class UserOut(BaseModel):
    id: str
    email: EmailStr

class AuthResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    user: UserOut

class PresignRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0)
    existing_file_id: str | None = None

class PresignResponse(BaseModel):
    file_id: str
    upload_url: str
    object_key: str
    expires_in: int

class RestoreRequest(BaseModel):
    version_id: str = Field(min_length=1, max_length=1024)
