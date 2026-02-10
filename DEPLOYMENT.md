# Cloud Build Deployment Guide

This guide explains how to deploy the France Practice Data Catalog to Google Cloud Platform using Cloud Build with a connected GitHub repository.

## Prerequisites

1. **Google Cloud Project** with billing enabled
2. **Artifact Registry** repository created
3. **OAuth 2.0 credentials** configured in Google Cloud Console
4. **GitHub repository** connected to Cloud Build

## Step 1: Create Artifact Registry Repository

```bash
gcloud artifacts repositories create [REPO_NAME] \
  --repository-format=docker \
  --location=[REGION] \
  --description="Docker repository for France Practice Data Catalog"
```

Example:
```bash
gcloud artifacts repositories create dataplex-business-ui-artifact \
  --repository-format=docker \
  --location=us-central1 \
  --description="Docker repository for France Practice Data Catalog"
```

## Step 2: Connect GitHub Repository to Cloud Build

1. Go to [Cloud Build Triggers](https://console.cloud.google.com/cloud-build/triggers)
2. Click **"Create Trigger"**
3. Select **"GitHub (Cloud Build GitHub App)"** or **"GitHub (Cloud Build GitHub App)"**
4. Authenticate and select your repository: `joseph-dejean/tst1`
5. Choose **"Push to a branch"** as the trigger event
6. Set branch pattern: `^main$` (or your preferred branch)
7. Configuration: **"Cloud Build configuration file (yaml or json)"**
8. Location: `cloudbuild.yaml`

## Step 3: Configure Substitution Variables

In the Cloud Build trigger, set these substitution variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `_REGION` | GCP region for Artifact Registry and Cloud Run | `us-central1` |
| `_REPO_NAME` | Artifact Registry repository name | `dataplex-business-ui-artifact` |
| `_APP_NAME` | Application name (used in image tags) | `dataplex-business-ui` |
| `_SERVICE_NAME` | Cloud Run service name | `france-practice-catalog` |
| `_ADMIN_EMAIL` | Admin email for access requests | `admin@example.com` |
| `_CLIENT_ID` | OAuth 2.0 Client ID | `123456789-abc.apps.googleusercontent.com` |
| `_CLIENT_SECRET` | OAuth 2.0 Client Secret | `GOCSPX-xxxxxxxxxxxxx` |
| `_GCP_LOCATION` | Dataplex location | `global` |
| `_GCP_REGION` | Dataplex region | `global` |

### Setting Substitution Variables in Cloud Build Trigger:

1. In the trigger configuration, scroll to **"Substitution variables"**
2. Click **"Add variable"** for each variable above
3. Enter the variable name (with underscore prefix) and value
4. **Important**: For `_CLIENT_SECRET`, consider using Secret Manager instead:
   - Create a secret in Secret Manager: `gcloud secrets create oauth-client-secret --data-file=-`
   - Reference it in cloudbuild.yaml: `${_CLIENT_SECRET}` (Cloud Build will automatically fetch from Secret Manager if configured)

## Step 4: Grant Required Permissions

Ensure the Cloud Build service account has the following roles:

```bash
PROJECT_ID=your-project-id
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

# Grant Artifact Registry Writer
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Grant Cloud Run Admin
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/run.admin"

# Grant Service Account User (to deploy to Cloud Run)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

## Step 5: Configure OAuth Redirect URI

After the first deployment, Cloud Run will provide a URL. You need to:

1. Copy the Cloud Run service URL (e.g., `https://france-practice-catalog-xxxxx.run.app`)
2. Go to [Google Cloud Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
3. Edit your OAuth 2.0 Client ID
4. Add to **Authorized JavaScript origins**:
   - `https://france-practice-catalog-xxxxx.run.app`
5. Add to **Authorized redirect URIs**:
   - `https://france-practice-catalog-xxxxx.run.app/auth/google/callback`
6. Save changes

## Step 6: Trigger Deployment

Deployment will automatically trigger when you:

1. Push to the `main` branch (or your configured branch)
2. Manually trigger the build from Cloud Build console

### Manual Trigger:

```bash
gcloud builds triggers run [TRIGGER_NAME] --branch=main
```

## Step 7: Verify Deployment

1. Check Cloud Build logs for successful build
2. Verify Cloud Run service is running
3. Access the application URL
4. Test OAuth login
5. Verify Data Products appear in search results

## Troubleshooting

### Build Fails with "Permission Denied"
- Ensure Cloud Build service account has required IAM roles (see Step 4)

### OAuth Login Fails
- Verify redirect URI is correctly configured in OAuth credentials
- Check that the Cloud Run URL matches the authorized origins

### Environment Variables Not Working
- Verify substitution variables are set in the trigger
- Check Cloud Run environment variables in the service configuration

### Build Takes Too Long
- The Dockerfile is optimized with layer caching
- Consider using Cloud Build machine type `E2_HIGHCPU_8` (already configured in cloudbuild.yaml)

## Updating Configuration

To update environment variables or configuration:

1. Edit `cloudbuild.yaml` if needed
2. Update substitution variables in the Cloud Build trigger
3. Push changes to trigger a new deployment

## Rollback

To rollback to a previous version:

```bash
gcloud run services update-traffic [SERVICE_NAME] \
  --to-revisions=[REVISION_NAME]=100 \
  --region=[REGION]
```

## Monitoring

- **Cloud Build History**: View build logs and status
- **Cloud Run Logs**: Monitor application logs
- **Cloud Run Metrics**: Track performance and errors

## Cost Optimization

- Cloud Build: Pay per build minute (first 120 build-minutes/day free)
- Cloud Run: Pay per request and compute time (generous free tier)
- Artifact Registry: Pay per GB stored (first 0.5 GB free)



