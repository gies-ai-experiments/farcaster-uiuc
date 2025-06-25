#!/bin/bash

# Shuttle Commands based on Snapchain Documentation
# https://snapchain-docs.vercel.app/guides/syncing-to-db

echo "Shuttle Helper Commands"
echo "======================"

# Load environment variables
source .env

# Set Shuttle environment variables based on Snapchain docs
export POSTGRES_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
export REDIS_URL="localhost:6379"
export HUB_HOST="localhost:3383"
export HUB_SSL="false"
export PARTITIONS="2"
export SHARD_INDEX="1"
export TOTAL_SHARDS="2"

echo "Environment configured:"
echo "POSTGRES_URL: $POSTGRES_URL"
echo "REDIS_URL: $REDIS_URL"
echo "HUB_HOST: $HUB_HOST"
echo "HUB_SSL: $HUB_SSL"
echo "PARTITIONS: $PARTITIONS"
echo "SHARD_INDEX: $SHARD_INDEX"
echo "TOTAL_SHARDS: $TOTAL_SHARDS"
echo ""

# Function to run shuttle worker
run_worker() {
    echo "Starting shuttle worker..."
    docker compose exec shuttle sh -c "cd /app/packages/shuttle && POSTGRES_URL=$POSTGRES_URL REDIS_URL=$REDIS_URL HUB_HOST=$HUB_HOST HUB_SSL=$HUB_SSL PARTITIONS=$PARTITIONS SHARD_INDEX=$SHARD_INDEX TOTAL_SHARDS=$TOTAL_SHARDS yarn start worker"
}

# Function to run shuttle backfill
run_backfill() {
    echo "Starting shuttle backfill..."
    # Configure with MAX_FID=100 or BACKFILL_FIDS=1,2,3 as needed
    docker compose exec shuttle sh -c "cd /app/packages/shuttle && POSTGRES_URL=$POSTGRES_URL REDIS_URL=$REDIS_URL HUB_HOST=$HUB_HOST HUB_SSL=$HUB_SSL PARTITIONS=$PARTITIONS SHARD_INDEX=$SHARD_INDEX TOTAL_SHARDS=$TOTAL_SHARDS MAX_FID=100 yarn start backfill"
}

# Function to start shuttle sync
run_sync() {
    echo "Starting shuttle sync from event stream..."
    docker compose exec shuttle sh -c "cd /app/packages/shuttle && POSTGRES_URL=$POSTGRES_URL REDIS_URL=$REDIS_URL HUB_HOST=$HUB_HOST HUB_SSL=$HUB_SSL PARTITIONS=$PARTITIONS SHARD_INDEX=$SHARD_INDEX TOTAL_SHARDS=$TOTAL_SHARDS yarn start start"
}

# Function to check shuttle logs
check_logs() {
    echo "Checking shuttle logs..."
    docker compose logs -f shuttle
}

# Function to check postgres connection
check_postgres() {
    echo "Checking PostgreSQL connection..."
    docker compose exec postgres psql -U ${DB_USER} -d ${DB_NAME} -c "SELECT version();"
}

# Function to check redis connection
check_redis() {
    echo "Checking Redis connection..."
    docker compose exec redis redis-cli ping
}

# Main menu
case "$1" in
    "worker")
        run_worker
        ;;
    "backfill")
        run_backfill
        ;;
    "sync")
        run_sync
        ;;
    "logs")
        check_logs
        ;;
    "check-postgres")
        check_postgres
        ;;
    "check-redis")
        check_redis
        ;;
    *)
        echo "Usage: $0 {worker|backfill|sync|logs|check-postgres|check-redis}"
        echo ""
        echo "Commands:"
        echo "  worker        - Start shuttle worker process"
        echo "  backfill      - Start shuttle backfill process"
        echo "  sync          - Start shuttle sync from event stream"
        echo "  logs          - Show shuttle container logs"
        echo "  check-postgres - Test PostgreSQL connection"
        echo "  check-redis   - Test Redis connection"
        echo ""
        echo "Examples:"
        echo "  ./shuttle_commands.sh worker"
        echo "  ./shuttle_commands.sh backfill"
        echo "  ./shuttle_commands.sh sync"
        exit 1
        ;;
esac 