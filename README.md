# Expensifyr

## Set Up Google Cloud Project

> Login to Google Cloud

gcloud auth login

> Set your project ID

gcloud config set project YOUR_PROJECT_ID

> Enable required APIs

1. gcloud services enable run.googleapis.com
2. gcloud services enable vision.googleapis.com
3. gcloud services enable firestore.googleapis.com
4. gcloud services enable Cloudbulid.googleapis.com


## Create a Service Account

> Using Google Cloud Console
1. Search for IAM & Admin
2. Select Service Accounts on left sidebar
3. Select Create Service Account
4. Set name to something meaningful
5. Select Create and continue
6. Set Role to Editor
7. Select Continue
8. Select Done


## Set Up Firestore

1. Go to Firestore Console
2. Click "Create a Firestore Database"
3. Set name to (default)
4. Choose standard Edition
5. Select Firestore Native
6. Choose your Region (will be used later)
7. Create Database
8. Once the database is created, select it
9. Click Indexes on the left sidebar
10. Select Create Index
11. Collection ID "receipts"
12. Field 1: userId - Ascending
13. Field 2: uploadedAt - Descending
14. Query scope - Collection
15. Select Create

## Deploy to Cloud Run

> Navigate to your project directory

cd Expensifyr

> Deploy directly to Cloud Run

gcloud run deploy Expensifyr \
  --source . \
  --platform managed \
  --region (Region Selection for Firestore) \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 300

## Once setup is complete Refer to this video
https://youtu.be/NuttwQlYYfQ
