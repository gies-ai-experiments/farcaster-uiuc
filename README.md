# farcaster-uiuc
Syncing data from pinata/creating farcaster hub on ncsa infra

## Data Collection

This project collects Farcaster data from the Pinata Hub API (https://hub.pinata.cloud/v1) without requiring an API key. The data collection process includes:

- FIDs (Farcaster IDs)
- Casts (posts)
- Reactions (likes and recasts)
- Verifications (Ethereum address verifications)
- Links (follows)
- User data (profile information)

The data is stored in a PostgreSQL database with the following tables:
- `fids`: Stores Farcaster IDs
- `casts`: Stores user posts
- `reactions`: Stores likes and recasts
- `verifications`: Stores Ethereum address verifications
- `links`: Stores follow relationships
- `user_data`: Stores user profile information

## Setup

1. Set up a PostgreSQL database
2. Configure the following environment variables in a `.env` file:
   ```
   DB_NAME=your_database_name
   DB_USER=your_database_user
   DB_PASSWORD=your_database_password
   DB_HOST=your_database_host
   DB_PORT=your_database_port
   ```

## Usage

1. Run the data collector:
   ```bash
   python farcaster_data_collector.py
   ```

2. Query the collected data:
   ```bash
   python query_farcaster_data.py
   ```

## Querying from Terminal

You can also query the database directly using the PostgreSQL command-line tool `psql`. Here are some example queries:

1. Connect to the database:
   ```bash
   psql -h <DB_HOST> -p <DB_PORT> -U <DB_USER> -d <DB_NAME>
   ```

2. Example queries:
   ```sql
   -- Get total number of FIDs
   SELECT COUNT(*) FROM fids;

   -- Get latest 5 casts
   SELECT text, timestamp FROM casts ORDER BY timestamp DESC LIMIT 5;

   -- Get user's profile data
   SELECT type, value FROM user_data WHERE fid = <FID>;

   -- Get user's followers
   SELECT fid FROM links WHERE target_fid = <FID> AND type = 'follow';

   -- Get user's verifications
   SELECT address FROM verifications WHERE fid = <FID>;

   -- Get user's reactions
   SELECT type, target_hash FROM reactions WHERE fid = <FID>;
   ```

3. To exit psql:
   ```sql
   \q
   ```

## Deployment

### Local Deployment with Docker

1. Build and start the containers:
   ```bash
   docker-compose up -d
   ```

2. View logs:
   ```bash
   docker-compose logs -f
   ```

3. Stop the containers:
   ```bash
   docker-compose down
   ```

### Production Deployment

The project uses GitHub Actions for CI/CD. To deploy to production:

1. Set up the following secrets in your GitHub repository:
   - `DOCKERHUB_USERNAME`: Your DockerHub username
   - `DOCKERHUB_TOKEN`: Your DockerHub access token
   - `SERVER_HOST`: Your server's hostname or IP
   - `SERVER_USERNAME`: SSH username for the server
   - `SERVER_SSH_KEY`: SSH private key for server access
   - `DB_NAME`: Database name
   - `DB_USER`: Database user
   - `DB_PASSWORD`: Database password

2. Push to the main branch to trigger deployment:
   ```bash
   git push origin main
   ```

The GitHub Actions workflow will:
1. Run tests
2. Build and push the Docker image
3. Deploy to your server using SSH
4. Set up the environment and start the containers

### Server Setup

1. Install Docker and Docker Compose on your server
2. Create the deployment directory:
   ```bash
   mkdir -p /opt/farcaster-collector
   ```

3. Copy the docker-compose.yml file to the server
4. The GitHub Actions workflow will handle the rest of the setup

# Farcaster Data Collection with Docker Compose

This Docker Compose setup provides a complete Farcaster data collection and analysis platform, including:

- **Farcaster Data Collector**: Custom Python service that fetches data from local Snapchain API
- **Snapchain**: Farcaster's new scalable implementation for real-time data
- **PostgreSQL**: Database for storing all Farcaster data
- **Redis**: Caching and queue management
- **Replicator**: Farcaster data replication service
- **Grafana**: Data visualization and dashboards
- **Redash**: SQL-based analytics and reporting
- **Caddy**: Reverse proxy and SSL termination

## Services Overview

### Core Services

1. **farcaster-data-collector**: Custom Python service that:
   - Fetches FIDs from local Snapchain API
   - Collects casts, reactions, verifications, links, and user data
   - Stores data in PostgreSQL with proper schema
   - Handles pagination and rate limiting

2. **snapchain**: Farcaster's newer, more scalable implementation
   - High-throughput (10,000+ TPS) Rust-based implementation
   - Real-time Farcaster protocol data access
   - P2P gossip network participation
   - HTTP and GRPC API endpoints

3. **postgres**: PostgreSQL database storing:
   - FIDs (Farcaster IDs)
   - Casts (posts)
   - Reactions (likes, recasts)
   - Verifications
   - Links (follows)
   - User data (profiles)

### Analysis & Visualization

4. **grafana**: Real-time dashboards and monitoring
5. **redash**: SQL-based analytics and reporting
6. **replicator**: Efficient data replication from Hubble to PostgreSQL

### Infrastructure

7. **redis**: Caching and message queuing
8. **caddy**: Reverse proxy with automatic HTTPS
9. **statsd**: Metrics collection

## Quick Start

1. **Clone and Setup**:
   ```bash
   # Copy environment file and configure
   cp env.example .env
   # Edit .env with your actual values
   ```

2. **Required Environment Variables**:
   - Database credentials: `DB_NAME`, `DB_USER`, `DB_PASSWORD`
   - No external API keys required - Snapchain connects directly to Farcaster network

3. **Start Services**:
   ```bash
   docker-compose up -d
   ```

4. **Access Points**:
   - Grafana: http://localhost:3000
   - Redash: http://localhost:5000
   - PostgreSQL: localhost:5432
   - Snapchain HTTP API: http://localhost:3381
   - Snapchain GRPC API: localhost:3383
   - Replicator UI: http://localhost:9000

## Data Collection Process

The Farcaster Data Collector follows this process:

1. **Fetch FIDs**: Retrieves first 100 FIDs from multiple shards
2. **For each FID, collect**:
   - **Casts**: All posts/messages by the user
   - **Reactions**: Likes and recasts made by the user
   - **Verifications**: Ethereum address verifications
   - **Links**: Follow relationships
   - **User Data**: Profile information (username, bio, PFP, etc.)

3. **Database Storage**: Uses upsert operations to handle updates
4. **Rate Limiting**: 1-second delays between API calls
5. **Error Handling**: Continues processing despite individual failures

## Database Schema

The collector creates these tables:

- `fids`: Farcaster user IDs
- `casts`: User posts/messages
- `reactions`: Likes and recasts
- `verifications`: Address verifications
- `links`: Follow relationships  
- `user_data`: Profile information

All tables include:
- Timestamps for data tracking
- `is_current` flags for soft deletes
- Proper foreign key relationships

## Development

### Customizing the Data Collector

The collector (`farcaster_data_collector.py`) can be modified to:
- Fetch different data types
- Change pagination limits
- Add custom data processing
- Implement different storage strategies

### Adding New Services

Add services to `docker-compose.yml` and ensure they're on the correct networks:
- `my-network`: For web services and APIs
- `farcaster-network`: For database connections

## Monitoring

- **Logs**: `docker-compose logs -f farcaster-data-collector`
- **Database**: Connect to PostgreSQL to query collected data
- **Metrics**: StatsD collects performance metrics
- **Health**: Built-in health checks for PostgreSQL and Redis

## Scaling

For production use:
- Increase `CONCURRENCY` and `PARTITIONS` for the replicator
- Add multiple data collector instances with FID ranges
- Implement data retention policies
- Set up proper monitoring and alerting

## Troubleshooting

1. **Data Collector Issues**:
   - Check Pinata API key validity
   - Verify database connection
   - Monitor rate limiting

2. **Database Connection**:
   - Ensure PostgreSQL is healthy
   - Check network connectivity
   - Verify credentials

3. **API Access**:
   - Confirm Hubble is running
   - Check RPC authentication
   - Verify network configuration
