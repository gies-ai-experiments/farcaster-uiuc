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
