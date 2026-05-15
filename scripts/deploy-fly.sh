#!/usr/bin/env bash
# Deploy Trusty Squire API to Fly.io

set -euo pipefail

echo "🚀 Deploying Trusty Squire API to Fly.io"
echo ""

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo "❌ flyctl not found. Install it:"
    echo "   curl -L https://fly.io/install.sh | sh"
    exit 1
fi

# Check if app exists
if ! flyctl apps list | grep -q "trusty-squire-api"; then
    echo "📝 Creating new Fly.io app..."
    flyctl apps create trusty-squire-api --org personal
    
    # Create Postgres database
    echo "📝 Creating Postgres database..."
    flyctl postgres create --name trusty-squire-db --region iad --initial-cluster-size 1
    flyctl postgres attach trusty-squire-db --app trusty-squire-api
    
    # Create Redis
    echo "📝 Creating Redis..."
    flyctl redis create --name trusty-squire-redis --region iad
    flyctl redis connect trusty-squire-redis --app trusty-squire-api
    
    echo ""
    echo "✅ Infrastructure created!"
    echo ""
fi

# Set secrets (you'll need to provide these)
echo "🔐 Setting secrets..."
echo "   Run these commands to set your secrets:"
echo ""
echo "   flyctl secrets set SESSION_JWT_SECRET=\$(openssl rand -hex 32) --app trusty-squire-api"
echo "   flyctl secrets set VOUCHFLOW_CUSTOMER_ID=your-customer-id --app trusty-squire-api"
echo "   flyctl secrets set AWS_ACCESS_KEY_ID=your-key --app trusty-squire-api"
echo "   flyctl secrets set AWS_SECRET_ACCESS_KEY=your-secret --app trusty-squire-api"
echo "   flyctl secrets set AWS_REGION=us-east-1 --app trusty-squire-api"
echo "   flyctl secrets set S3_BUCKET=trusty-squire-inbound-email --app trusty-squire-api"
echo ""
read -p "Press Enter once secrets are set, or Ctrl-C to abort..."

# Deploy
echo ""
echo "🚢 Deploying..."
flyctl deploy --app trusty-squire-api

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Your API is available at:"
flyctl status --app trusty-squire-api | grep "Hostname"
echo ""
echo "Next steps:"
echo "1. Configure your domain DNS to point to Fly.io"
echo "2. Set up inbound email (Mailgun or Postmark)"
echo "3. Configure webhook to: https://your-app.fly.dev/v1/webhooks/ses"
