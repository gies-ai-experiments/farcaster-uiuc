import os
import requests
import psycopg2
import time
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

SNAPCHAIN_API = os.getenv("SNAPCHAIN_API", "http://localhost:3381")
POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://user:password@postgres:5432/dbname")

# Example table creation (run this in your DB beforehand or automate in script)
# CREATE TABLE IF NOT EXISTS casts (
#     fid BIGINT,
#     hash TEXT PRIMARY KEY,
#     text TEXT
# );

def create_database_table():
    """Create the casts table if it doesn't exist"""
    try:
        conn = psycopg2.connect(POSTGRES_URL)
        cur = conn.cursor()
        
        # Create table if it doesn't exist
        cur.execute("""
            CREATE TABLE IF NOT EXISTS casts (
                fid BIGINT,
                hash TEXT PRIMARY KEY,
                text TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        
        # Create index for better performance
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_casts_fid ON casts(fid);
        """)
        
        conn.commit()
        cur.close()
        conn.close()
        logger.info("Database table 'casts' created/verified successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to create database table: {e}")
        return False

def wait_for_postgres():
    """Wait for PostgreSQL to be available"""
    max_retries = 30
    for i in range(max_retries):
        try:
            conn = psycopg2.connect(POSTGRES_URL)
            conn.close()
            logger.info("PostgreSQL connection successful")
            return True
        except Exception as e:
            logger.info(f"Waiting for PostgreSQL... ({i+1}/{max_retries}): {e}")
            time.sleep(5)
    return False

def check_api_health():
    """Check if the API is accessible"""
    try:
        url = f"{SNAPCHAIN_API}/v1/info"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        logger.info(f"API is healthy: {resp.json()}")
        return True
    except Exception as e:
        logger.warning(f"API health check failed: {e}")
        return False

def get_all_fids():
    fids = []
    
    # Check if API is accessible, but don't fail if it's not
    if not check_api_health():
        logger.warning("API health check failed, but continuing anyway...")
        global SNAPCHAIN_API
        SNAPCHAIN_API = "http://snap_read:3381"
        if not check_api_health():
            logger.warning("Cannot connect to snapchain API, will retry later")
            return []
    
    # Get FIDs from both shards
    for shard_id in [1, 2]:
        logger.info(f"Fetching FIDs from shard {shard_id}")
        shard_fids = get_fids_from_shard(shard_id)
        fids.extend(shard_fids)
        logger.info(f"Got {len(shard_fids)} FIDs from shard {shard_id}")
    
    # Remove duplicates while preserving order
    unique_fids = list(dict.fromkeys(fids))
    logger.info(f"Total unique FIDs from all shards: {len(unique_fids)}")
    
    return unique_fids

def get_fids_from_shard(shard_id):
    """Get FIDs from a specific shard"""
    fids = []
    page_token = None
    
    try:
        while True:
            params = {"shard_id": shard_id}
            if page_token:
                params["pageToken"] = page_token
            
            url = f"{SNAPCHAIN_API}/v1/fids"
            logger.info(f"Requesting: {url} with params: {params}")
            resp = requests.get(url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            
            shard_fids = data.get("fids", [])
            fids.extend(shard_fids)
            page_token = data.get("nextPageToken")
            
            logger.info(f"Got {len(shard_fids)} FIDs from shard {shard_id}, nextPageToken: {page_token}")
            
            if not page_token:
                break
                
    except Exception as e:
        logger.error(f"Failed to get FIDs from shard {shard_id}: {e}")
        return []
    
    return fids

def get_casts_by_fid(fid):
    try:
        url = f"{SNAPCHAIN_API}/v1/castsByFid?fid={fid}"
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.json().get("messages", [])
    except Exception as e:
        logger.error(f"Failed to get casts for FID {fid}: {e}")
        return []

def insert_casts_to_db(casts):
    if not casts:
        return
        
    try:
        conn = psycopg2.connect(POSTGRES_URL)
        cur = conn.cursor()
        for cast in casts:
            try:
                fid = cast.get("data", {}).get("fid")
                hash_ = cast.get("hash")
                text = cast.get("data", {}).get("castAddBody", {}).get("text")
                cur.execute(
                    """
                    INSERT INTO casts (fid, hash, text)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (hash) DO NOTHING
                    """,
                    (fid, hash_, text)
                )
            except Exception as e:
                logger.error(f"Error inserting cast: {e}")
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Database connection error: {e}")

def main():
    logger.info("Starting snapchain to postgres sync...")
    
    # Wait for PostgreSQL to be available
    if not wait_for_postgres():
        logger.error("PostgreSQL is not available after waiting. Exiting.")
        return
    
    # Create database table
    if not create_database_table():
        logger.error("Failed to create database table. Exiting.")
        return
    
    # Continuous sync loop
    while True:
        try:
            logger.info("Attempting to fetch FIDs...")
            fids = get_all_fids()
            
            if not fids:
                logger.warning("No FIDs fetched, waiting 60 seconds before retry...")
                time.sleep(60)
                continue
                
            logger.info(f"Fetched {len(fids)} FIDs from Snapchain API.")
            
            for i, fid in enumerate(fids, 1):
                logger.info(f"Fetching casts for FID {fid} ({i}/{len(fids)})")
                try:
                    casts = get_casts_by_fid(fid)
                    if casts:
                        insert_casts_to_db(casts)
                        logger.info(f"Inserted {len(casts)} casts for FID {fid}")
                    else:
                        logger.info(f"No casts found for FID {fid}")
                except Exception as e:
                    logger.error(f"Error processing FID {fid}: {e}")
                time.sleep(1)  # avoid hammering the API
            
            logger.info("Sync cycle completed. Waiting 300 seconds before next cycle...")
            time.sleep(300)  # Wait 5 minutes before next full sync
            
        except KeyboardInterrupt:
            logger.info("Received interrupt signal, shutting down...")
            break
        except Exception as e:
            logger.error(f"Unexpected error in main loop: {e}")
            logger.info("Waiting 60 seconds before retry...")
            time.sleep(60)

if __name__ == "__main__":
    main() 