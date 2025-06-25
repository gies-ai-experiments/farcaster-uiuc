#!/bin/bash

# Redash Setup Script for Farcaster Data
echo "Redash Setup for Farcaster Data"
echo "==============================="

# Load environment variables
if [ -f .env ]; then
    source .env
    echo "Loaded environment variables from .env"
else
    echo "Warning: .env file not found"
fi

# Function to wait for service to be ready
wait_for_service() {
    local service=$1
    local max_attempts=30
    local attempt=0
    
    echo "Waiting for $service to be ready..."
    while [ $attempt -lt $max_attempts ]; do
        if docker compose exec $service echo "Service is up" >/dev/null 2>&1; then
            echo "$service is ready!"
            return 0
        fi
        attempt=$((attempt + 1))
        echo "Attempt $attempt/$max_attempts - waiting for $service..."
        sleep 5
    done
    
    echo "Error: $service failed to start within expected time"
    return 1
}

# Function to initialize Redash database
init_redash_db() {
    echo "Initializing Redash database..."
    docker compose exec redash python manage.py database create_tables
    
    echo "Creating initial admin user..."
    echo "You'll be prompted to create an admin user account."
    docker compose exec -it redash python manage.py users create_root
}

# Function to create Farcaster data source
create_farcaster_datasource() {
    echo "Creating Farcaster PostgreSQL data source..."
    
    cat > /tmp/create_datasource.py << EOF
import requests
import json
import os

# Redash API configuration
REDASH_URL = "http://localhost:5001"
API_KEY = ""  # Will be set after first login

# Data source configuration
datasource_config = {
    "name": "Farcaster Database",
    "type": "pg",
    "options": {
        "host": "postgres",
        "port": 5432,
        "user": "${DB_USER}",
        "password": "${DB_PASSWORD}",
        "dbname": "${DB_NAME}",
        "sslmode": "prefer"
    }
}

print("Data source configuration ready:")
print(json.dumps(datasource_config, indent=2))
print("\nTo create this data source:")
print("1. Login to Redash at http://your-server:5001")
print("2. Go to Settings > Data Sources")
print("3. Click 'New Data Source'")
print("4. Select PostgreSQL")
print("5. Use the configuration above")
EOF

    python3 /tmp/create_datasource.py
    rm /tmp/create_datasource.py
}

# Function to create sample queries
create_sample_queries() {
    echo "Sample Farcaster Queries for Redash"
    echo "===================================="
    
    cat << 'EOF'

Here are some sample SQL queries you can use in Redash:

1. Total Casts Count:
SELECT COUNT(*) as total_casts FROM casts;

2. Recent Casts:
SELECT 
    fid,
    text,
    timestamp,
    created_at
FROM casts 
ORDER BY timestamp DESC 
LIMIT 100;

3. Top Users by Cast Count:
SELECT 
    fid,
    COUNT(*) as cast_count
FROM casts 
GROUP BY fid 
ORDER BY cast_count DESC 
LIMIT 20;

4. Casts Over Time:
SELECT 
    DATE(timestamp) as date,
    COUNT(*) as daily_casts
FROM casts 
WHERE timestamp >= NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp)
ORDER BY date;

5. Reactions Summary:
SELECT 
    reaction_type,
    COUNT(*) as count
FROM reactions 
GROUP BY reaction_type;

6. User Information:
SELECT 
    fid,
    display_name,
    username,
    follower_count,
    following_count
FROM user_data 
WHERE type = 6  -- Display name
ORDER BY follower_count DESC 
LIMIT 50;

EOF
}

# Function to check service health
check_services() {
    echo "Checking service health..."
    
    services=("postgres" "redis" "redash" "redash-worker" "redash-scheduler")
    
    for service in "${services[@]}"; do
        if docker compose ps $service | grep -q "Up"; then
            echo "✓ $service is running"
        else
            echo "✗ $service is not running"
        fi
    done
}

# Function to show access information
show_access_info() {
    echo "Redash Access Information"
    echo "========================"
    echo "Web Interface: http://your-server-ip:5001"
    echo "Local Access:  http://localhost:5001"
    echo ""
    echo "Database Connection Details for Redash:"
    echo "Host: postgres"
    echo "Port: 5432"
    echo "Database: ${DB_NAME}"
    echo "Username: ${DB_USER}"
    echo "Password: ${DB_PASSWORD}"
    echo ""
    echo "Note: Use these details when creating the PostgreSQL data source in Redash"
}

# Main execution
case "$1" in
    "init")
        echo "Starting Redash initialization..."
        wait_for_service postgres
        wait_for_service redis
        wait_for_service redash
        init_redash_db
        create_farcaster_datasource
        show_access_info
        ;;
    "samples")
        create_sample_queries
        ;;
    "check")
        check_services
        ;;
    "info")
        show_access_info
        ;;
    *)
        echo "Usage: $0 {init|samples|check|info}"
        echo ""
        echo "Commands:"
        echo "  init     - Initialize Redash database and create admin user"
        echo "  samples  - Show sample SQL queries for Farcaster data"
        echo "  check    - Check if all services are running"
        echo "  info     - Show access information"
        echo ""
        echo "Examples:"
        echo "  ./redash_setup.sh init"
        echo "  ./redash_setup.sh samples"
        echo "  ./redash_setup.sh check"
        exit 1
        ;;
esac 