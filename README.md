# CloudDrop

CloudDrop is a small AWS-backed file-management application built with React, FastAPI, SQLite and Amazon S3. It demonstrates real object uploads using S3 presigned URLs, S3 Versioning, per-user authorization and restoration of prior object contents.

> **Important:** This is an interview/demo project, not a production-hardened storage service. It intentionally uses SQLite on the EC2 host to keep the infrastructure small. Use a managed database, migrations, a stronger session design, monitoring, malware scanning, upload quotas and a formal threat model before production use.

## Architecture

- **React + Vite:** browser interface.
- **FastAPI:** registration, login, API authorization, upload orchestration and S3 operations.
- **SQLite + SQLAlchemy:** user and logical-file metadata.
- **Amazon EC2:** hosts Nginx and the FastAPI process.
- **Amazon S3:** private object storage with bucket versioning enabled.
- **IAM instance role:** grants the EC2 application narrowly scoped S3 permissions without static AWS keys.

The browser requests a presigned PUT URL from FastAPI and uploads the bytes directly to S3. FastAPI then verifies the object using HeadObject and updates SQLite. Re-uploading to the same object key creates a new S3 version. Restoring an earlier version uses CopyObject with the source VersionId, which creates a new latest version while retaining the prior versions.

## Features

- Register and log in using an Argon2 password hash and short-lived JWT.
- Upload a new file directly to a private S3 bucket.
- Upload a new version to the same S3 object key.
- List the user's file metadata.
- List S3 object versions and delete markers.
- Download the current object or a specific historical version.
- Restore an earlier version as a new latest version.
- Delete a file by creating an S3 delete marker; old versions remain retained.
- Enforce per-user ownership in every file API route.

## Requirements

- Python 3.11 or newer recommended.
- Node.js 20 or newer recommended.
- An AWS account that is permitted to create/use EC2 and S3 under its current account plan.
- An S3 bucket with Versioning enabled.

## 1. Local setup

### Backend

```bash
cd backend
python -m venv venv
```

Activate the environment:

- Windows PowerShell: `venv\Scripts\Activate.ps1`
- macOS/Linux: `source venv/bin/activate`

Install packages:

```bash
pip install -r requirements.txt
```

Copy `.env.example` to `.env` in the backend directory and set:

- `JWT_SECRET`: a random secret of at least 32 bytes, for example generated with `python -c "import secrets; print(secrets.token_hex(32))"`.
- `S3_BUCKET_NAME`: your bucket name.
- `AWS_REGION`: your bucket's region.
- `DATABASE_URL`: keep `sqlite:///./clouddrop.db` for local use.

For local AWS testing only, configure a separate least-privilege IAM identity/profile (never use root credentials). Install the AWS CLI, then run `aws configure --profile clouddrop-dev` and enter that identity's access key, secret key and the bucket region. In the same terminal where you start FastAPI, select the profile:

- Windows PowerShell: `$env:AWS_PROFILE="clouddrop-dev"`
- macOS/Linux: `export AWS_PROFILE=clouddrop-dev`

Boto3 then uses that profile locally. Do not put access keys in source code or commit `.env`. On EC2, remove `AWS_PROFILE` and use the EC2 instance role instead.

Run the API:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Health check: http://127.0.0.1:8000/api/health
API docs: http://127.0.0.1:8000/docs

### Frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL (usually http://localhost:5173). The Vite dev server proxies `/api` requests to FastAPI.

## 2. Create and configure the S3 bucket

1. Open the Amazon S3 console and create a globally unique bucket in the region you intend to use (Mumbai is `ap-south-1`).
2. Keep **Block all public access** enabled.
3. Keep Object Ownership as **Bucket owner enforced**.
4. Enable default server-side encryption (SSE-S3 is sufficient for this demo).
5. Under **Properties → Bucket Versioning**, enable Versioning.
6. Under **Permissions → CORS**, set a rule for your exact frontend origin. During local development, use `http://localhost:5173`; once deployed, use the public site origin too:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedOrigins": ["http://localhost:5173", "http://YOUR_EC2_PUBLIC_IP"],
    "ExposeHeaders": ["ETag", "x-amz-version-id"],
    "MaxAgeSeconds": 3000
  }
]
```

A copy of this example is in `deployment/s3-cors.example.json`. Replace the example origin values with the exact origins you actually use. If using HTTPS and a domain, add that HTTPS origin. Do not make the bucket public to solve CORS problems.

## 3. Create a least-privilege EC2 IAM role

Create an IAM role with trusted entity **AWS service → EC2**. Attach a custom policy, replacing `YOUR_BUCKET_NAME` with your bucket name. A ready-to-edit copy is in `deployment/clouddrop-s3-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOnlyCloudDropBucketVersions",
      "Effect": "Allow",
      "Action": ["s3:GetBucketVersioning", "s3:ListBucketVersions"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME"
    },
    {
      "Sid": "ManageCloudDropObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:DeleteObject", "s3:DeleteObjectVersion"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/users/*"
    }
  ]
}
```

Attach this role to the EC2 instance through **EC2 → Instances → select instance → Actions → Security → Modify IAM role**. The app uses the EC2 instance profile automatically. Do not create access keys for the EC2 application.

For local development, create a separate IAM identity/profile with the same restricted policy. Do not use root credentials.

## 4. EC2 deployment

**Check the account plan before creating resources.** The AWS Free Plan is limited to eligible services and has an expiry/credit limit. EC2 availability and instance choices are determined by the account console. If AWS asks you to upgrade to a Paid Plan, stop and review the costs before accepting.

1. Launch an Ubuntu LTS EC2 instance in the same region as the S3 bucket, using an instance type shown as eligible/available for your plan.
2. Create/download an SSH key pair and keep the `.pem` file private.
3. Configure the security group: SSH port 22 from **My IP only**, HTTP port 80 from the internet. Add HTTPS port 443 only when configured. Do not expose port 8000 publicly.
4. Attach the IAM role described above.
5. Connect from PowerShell:

```powershell
ssh -i .\CloudDrop.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

6. Install packages:

```bash
sudo apt update
sudo apt install -y nginx git python3-venv python3-pip
```

7. Clone the repository and install backend dependencies:

```bash
sudo git clone https://github.com/YOUR_GITHUB_USER/CloudDrop.git /opt/CloudDrop
sudo chown -R ubuntu:ubuntu /opt/CloudDrop
cd /opt/CloudDrop/backend
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

8. Create the persistent SQLite directory and environment file:

```bash
sudo mkdir -p /var/lib/clouddrop
sudo chown ubuntu:ubuntu /var/lib/clouddrop
sudo tee /etc/clouddrop.env > /dev/null <<'EOF'
APP_ENV=production
JWT_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
JWT_EXPIRE_MINUTES=120
DATABASE_URL=sqlite:////var/lib/clouddrop/app.db
AWS_REGION=ap-south-1
S3_BUCKET_NAME=REPLACE_WITH_YOUR_BUCKET
MAX_UPLOAD_BYTES=26214400
ALLOWED_ORIGINS=http://REPLACE_WITH_YOUR_EC2_PUBLIC_IP
EOF
sudo chmod 600 /etc/clouddrop.env
```

Generate the JWT secret on the instance with `openssl rand -hex 32` and replace the placeholder. If you configure HTTPS/domain, change ALLOWED_ORIGINS to the exact HTTPS origin.

9. Install and start the systemd service:

```bash
sudo cp /opt/CloudDrop/deployment/clouddrop.service /etc/systemd/system/clouddrop.service
sudo systemctl daemon-reload
sudo systemctl enable --now clouddrop
sudo systemctl status clouddrop
```

10. Build the frontend on your development machine and copy it to EC2. From the project root on your local machine:

```bash
cd frontend
npm install
npm run build
scp -i ../CloudDrop.pem -r dist ubuntu@YOUR_EC2_PUBLIC_IP:/home/ubuntu/clouddrop-dist
```

11. On EC2, install Nginx configuration and the build:

```bash
sudo mkdir -p /var/www/clouddrop
sudo cp -r /home/ubuntu/clouddrop-dist/* /var/www/clouddrop/
sudo cp /opt/CloudDrop/deployment/nginx.conf /etc/nginx/sites-available/clouddrop
sudo ln -sf /etc/nginx/sites-available/clouddrop /etc/nginx/sites-enabled/clouddrop
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

12. Open `http://YOUR_EC2_PUBLIC_IP` and test registration, upload, version history, restore and download. For a short interview demo, use a disposable test account and never reuse a personal password over plain HTTP. For normal use, point a domain's DNS A record to the instance and configure HTTPS with a trusted certificate (for example, Certbot / Let's Encrypt) before entering real credentials.

If the instance public IP changes after stop/start, update the S3 CORS AllowedOrigins and `/etc/clouddrop.env` ALLOWED_ORIGINS, then restart the service and reload Nginx as needed.

## 5. Verify versioning

1. Register and sign in.
2. Upload a small text file as a new file.
3. Change its contents locally and upload it again using **New version of ...** for that same logical file.
4. Open Version History. Confirm S3 returns at least two different VersionIds.
5. Download the older version and compare its contents.
6. Restore the older version. S3 should create a new latest VersionId; the previous versions should still be present.
7. Delete the file. S3 creates a delete marker and the application marks the metadata row as deleted. Open version history and restore a prior real version to make the object current again.

## API summary

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/health`
- `GET /api/files`
- `POST /api/files/presign`
- `POST /api/files/{file_id}/complete`
- `GET /api/files/{file_id}/versions`
- `GET /api/files/{file_id}/download?version_id=...`
- `POST /api/files/{file_id}/restore`
- `DELETE /api/files/{file_id}`

All file endpoints require `Authorization: Bearer <JWT>` and check that the file belongs to the authenticated user.

## Security and demo limitations

- Never enable public bucket access.
- Never commit `.env`, private keys, database files or AWS access keys.
- Use an EC2 instance role in AWS; no static keys on the server.
- Keep SSH restricted to your current IP and do not expose Uvicorn port 8000.
- Presigned URLs are bearer credentials until they expire; keep them short-lived.
- The demo uses browser localStorage for the JWT. A production application should prefer Secure, HttpOnly, SameSite cookies and implement CSRF protections where appropriate.
- The SQLite database is local to the EC2 instance. Back it up and use a managed database for production.
- This project does not implement malware scanning, deduplication, large multipart uploads, retention/lifecycle policies or multi-region disaster recovery.
- S3 Versioning retains old versions and delete markers. Storage costs can grow. Clean up all object versions and delete markers when you finish testing.

