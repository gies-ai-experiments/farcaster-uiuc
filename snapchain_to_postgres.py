import os
import requests
import psycopg2
import time

SNAPCHAIN_API = os.getenv("SNAPCHAIN_API", "http://localhost:3381")
POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://user:password@postgres:5432/dbname")

# Example table creation (run this in your DB beforehand or automate in script)
# CREATE TABLE IF NOT EXISTS casts (
#     fid BIGINT,
#     hash TEXT PRIMARY KEY,
#     text TEXT
# );

def check_api_health():
    """Check if the API is accessible"""
    try:
        url = f"{SNAPCHAIN_API}/v1/info"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        print(f"API is healthy: {resp.json()}")
        return True
    except Exception as e:
        print(f"API health check failed: {e}")
        return False

def get_all_fids():
    fids = []
    page_token = None
    
    # First check if API is accessible
    if not check_api_health():
        print("API health check failed, trying with snap_read hostname...")
        global SNAPCHAIN_API
        SNAPCHAIN_API = "http://snap_read:3381"
        if not check_api_health():
            raise Exception("Cannot connect to snapchain API")
    
    while True:
        params = {}
        if page_token:
            params["pageToken"] = page_token
        url = f"{SNAPCHAIN_API}/v1/fids"
        print(f"Requesting: {url} with params: {params}")
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        fids.extend(data.get("fids", []))
        page_token = data.get("nextPageToken")
        print(f"Got {len(data.get('fids', []))} FIDs, nextPageToken: {page_token}")
        if not page_token:
            break
    return fids

def get_casts_by_fid(fid):
    url = f"{SNAPCHAIN_API}/v1/castsByFid?fid={fid}"
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    return response.json().get("messages", [])

def insert_casts_to_db(casts):
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
            print(f"Error inserting cast: {e}")
    conn.commit()
    cur.close()
    conn.close()

def main():
    fids = get_all_fids()
    print(f"Fetched {len(fids)} FIDs from Snapchain API.")
    for i, fid in enumerate(fids, 1):
        print(f"Fetching casts for FID {fid} ({i}/{len(fids)})")
        try:
            casts = get_casts_by_fid(fid)
            insert_casts_to_db(casts)
            print(f"Inserted {len(casts)} casts for FID {fid}")
        except Exception as e:
            print(f"Error processing FID {fid}: {e}")
        time.sleep(1)  # avoid hammering the API

if __name__ == "__main__":
    main() 