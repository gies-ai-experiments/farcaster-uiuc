import os
import requests
import psycopg2
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from psycopg2.pool import ThreadedConnectionPool
import threading

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

SNAPCHAIN_API = os.getenv("SNAPCHAIN_API", "http://localhost:3381")
POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://user:password@postgres:5432/dbname")
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "10"))  # Number of parallel workers

# Global connection pool
connection_pool = None
pool_lock = threading.Lock()

def init_connection_pool():
    """Initialize PostgreSQL connection pool"""
    global connection_pool
    try:
        # Parse connection string to get components
        import urllib.parse as urlparse
        url = urlparse.urlparse(POSTGRES_URL)
        
        connection_pool = ThreadedConnectionPool(
            minconn=1,
            maxconn=MAX_WORKERS + 5,  # A few extra connections
            host=url.hostname,
            port=url.port,
            database=url.path[1:],  # Remove leading slash
            user=url.username,
            password=url.password
        )
        logger.info(f"Connection pool initialized with max {MAX_WORKERS + 5} connections")
        return True
    except Exception as e:
        logger.error(f"Failed to initialize connection pool: {e}")
        return False

def get_db_connection():
    """Get a connection from the pool"""
    global connection_pool
    if connection_pool is None:
        if not init_connection_pool():
            return None
    
    try:
        return connection_pool.getconn()
    except Exception as e:
        logger.error(f"Failed to get connection from pool: {e}")
        return None

def return_db_connection(conn):
    """Return a connection to the pool"""
    global connection_pool
    if connection_pool and conn:
        try:
            connection_pool.putconn(conn)
        except Exception as e:
            logger.error(f"Failed to return connection to pool: {e}")

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
    
    # Parallelize FID retrieval from both shards
    with ThreadPoolExecutor(max_workers=2) as executor:
        future_to_shard = {executor.submit(get_fids_from_shard, shard_id): shard_id for shard_id in [1, 2]}
        
        for future in as_completed(future_to_shard):
            shard_id = future_to_shard[future]
            try:
                shard_fids = future.result()
                fids.extend(shard_fids)
                logger.info(f"Got {len(shard_fids)} FIDs from shard {shard_id}")
            except Exception as e:
                logger.error(f"Failed to get FIDs from shard {shard_id}: {e}")
    
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

def process_fid(fid):
    """Process a single FID: fetch casts and insert to database"""
    try:
        casts = get_casts_by_fid(fid)
        if casts:
            inserted_count = insert_casts_to_db(casts)
            logger.info(f"FID {fid}: Inserted {inserted_count} casts")
            return inserted_count
        else:
            logger.info(f"FID {fid}: No casts found")
            return 0
    except Exception as e:
        logger.error(f"Error processing FID {fid}: {e}")
        return 0

def insert_casts_to_db(casts):
    """Insert casts to database using connection pool"""
    if not casts:
        return 0
    
    conn = get_db_connection()
    if not conn:
        logger.error("Failed to get database connection")
        return 0
    
    try:
        cur = conn.cursor()
        inserted_count = 0
        
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
                if cur.rowcount > 0:
                    inserted_count += 1
                    
            except Exception as e:
                logger.error(f"Error inserting cast: {e}")
        
        conn.commit()
        cur.close()
        return inserted_count
        
    except Exception as e:
        logger.error(f"Database connection error: {e}")
        return 0
    finally:
        return_db_connection(conn)

def process_fids_parallel(fids):
    """Process FIDs in parallel"""
    total_inserted = 0
    
    # Process FIDs in batches to avoid overwhelming the API
    batch_size = MAX_WORKERS * 2
    
    for i in range(0, len(fids), batch_size):
        batch = fids[i:i+batch_size]
        logger.info(f"Processing batch {i//batch_size + 1}: FIDs {i+1} to {min(i+batch_size, len(fids))}")
        
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            # Submit all FIDs in the current batch
            future_to_fid = {executor.submit(process_fid, fid): fid for fid in batch}
            
            # Collect results
            batch_inserted = 0
            for future in as_completed(future_to_fid):
                fid = future_to_fid[future]
                try:
                    inserted_count = future.result()
                    batch_inserted += inserted_count
                except Exception as e:
                    logger.error(f"Error in future for FID {fid}: {e}")
            
            total_inserted += batch_inserted
            logger.info(f"Batch completed: {batch_inserted} casts inserted")
            
            # Small delay between batches to be gentle on the API
            time.sleep(2)
    
    return total_inserted

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
    
    # Initialize connection pool
    if not init_connection_pool():
        logger.error("Failed to initialize connection pool. Exiting.")
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
            logger.info(f"Starting parallel processing with {MAX_WORKERS} workers...")
            
            start_time = time.time()
            total_inserted = process_fids_parallel(fids)
            end_time = time.time()
            
            logger.info(f"Sync cycle completed in {end_time - start_time:.2f} seconds")
            logger.info(f"Total casts inserted: {total_inserted}")
            logger.info("Waiting 300 seconds before next cycle...")
            time.sleep(300)  # Wait 5 minutes before next full sync
            
        except KeyboardInterrupt:
            logger.info("Received interrupt signal, shutting down...")
            break
        except Exception as e:
            logger.error(f"Unexpected error in main loop: {e}")
            logger.info("Waiting 60 seconds before retry...")
            time.sleep(60)
    
    # Clean up connection pool
    if connection_pool:
        connection_pool.closeall()
        logger.info("Connection pool closed")

if __name__ == "__main__":
    main() 