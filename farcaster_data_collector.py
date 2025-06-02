import requests
import psycopg2
from psycopg2 import sql
import time
import json
from datetime import datetime
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Database configuration
DB_CONFIG = {
    'dbname': os.getenv('DB_NAME'),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'host': os.getenv('DB_HOST'),
    'port': os.getenv('DB_PORT')
}

# Pinata Hub API configuration
PINATA_API_URL = "https://hub.pinata.cloud/v1"
HEADERS = {
    #'Authorization': f"Bearer {os.getenv('PINATA_API_KEY')}"
}

def create_database_tables():
    """Create necessary database tables if they don't exist"""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    
    # Create tables
    tables = {
        'fids': """
            CREATE TABLE IF NOT EXISTS fids (
                fid INTEGER PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """,
        'casts': """
            CREATE TABLE IF NOT EXISTS casts (
                id SERIAL PRIMARY KEY,
                fid INTEGER REFERENCES fids(fid),
                hash TEXT,
                parent_hash TEXT,
                author_fid INTEGER,
                text TEXT,
                timestamp TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """,
        'reactions': """
            CREATE TABLE IF NOT EXISTS reactions (
                id SERIAL PRIMARY KEY,
                fid INTEGER REFERENCES fids(fid),
                target_fid INTEGER,
                target_hash TEXT,
                type TEXT,
                timestamp TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """,
        'verifications': """
            CREATE TABLE IF NOT EXISTS verifications (
                id SERIAL PRIMARY KEY,
                fid INTEGER REFERENCES fids(fid),
                address TEXT,
                timestamp TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """,
        'links': """
            CREATE TABLE IF NOT EXISTS links (
                id SERIAL PRIMARY KEY,
                fid INTEGER REFERENCES fids(fid),
                target_fid INTEGER,
                type TEXT,
                timestamp TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """,
        'user_data': """
            CREATE TABLE IF NOT EXISTS user_data (
                id SERIAL PRIMARY KEY,
                fid INTEGER REFERENCES fids(fid),
                type TEXT,
                value TEXT,
                timestamp TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
    }
    
    for table_name, create_query in tables.items():
        cur.execute(create_query)
    
    conn.commit()
    cur.close()
    conn.close()

def fetch_all_fids():
    """Fetch first 100 FIDs using pagination from both shards"""
    all_fids = []
    shard_ids = [1, 2]  # List of shard IDs to fetch from
    
    for shard_id in shard_ids:
        if len(all_fids) >= 100:  # Stop if we have 100 FIDs
            break
            
        try:
            url = f"{PINATA_API_URL}/fids"
            params = {
                'pageSize': 100,  # Reduced page size
                'shard_id': shard_id
            }
            
            response = requests.get(url, headers=HEADERS, params=params)
            response.raise_for_status()
            
            data = response.json()
            new_fids = data.get('fids', [])
            if not new_fids:
                break
                
            # Only take as many FIDs as needed to reach 100
            remaining_slots = 100 - len(all_fids)
            all_fids.extend(new_fids[:remaining_slots])
            print(f"Fetched {len(new_fids[:remaining_slots])} FIDs from shard {shard_id}")
            
            if len(all_fids) >= 100:
                break
                
        except requests.exceptions.RequestException as e:
            print(f"Error fetching FIDs from shard {shard_id}: {str(e)}")
            break
        except Exception as e:
            print(f"Unexpected error while fetching FIDs from shard {shard_id}: {str(e)}")
            break
    
    print(f"Total FIDs collected: {len(all_fids)}")
    return all_fids

def fetch_and_store_farcaster_data(fid):
    """Fetch and store all Farcaster data for a given FID"""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    
    # Store FID
    cur.execute("INSERT INTO fids (fid) VALUES (%s) ON CONFLICT (fid) DO NOTHING", (fid,))
    
    # Fetch and store casts
    fetch_and_store_casts(cur, fid)
    
    # Fetch and store reactions
    fetch_and_store_reactions(cur, fid)
    
    # Fetch and store verifications
    fetch_and_store_verifications(cur, fid)
    
    # Fetch and store links
    fetch_and_store_links(cur, fid)
    
    # Fetch and store user data
    fetch_and_store_user_data(cur, fid)
    
    conn.commit()
    cur.close()
    conn.close()

def fetch_and_store_casts(cur, fid):
    """Fetch and store casts for a given FID"""
    url = f"{PINATA_API_URL}/castsByFid"
    params = {'fid': fid}
    
    print(f"\nFetching casts for FID {fid}...")
    response = requests.get(url, headers=HEADERS, params=params)
    print(f"Response status code: {response.status_code}")
    
    if response.status_code == 200:
        data = response.json()
        #print(data)
        casts = data.get('messages', [])
        print(f"Found {len(casts)} casts")
        
        for cast in casts:
            try:
                #print(cast.get('data'))
                cur.execute("""
                    INSERT INTO casts (fid, hash, parent_hash, author_fid, text, timestamp)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (
                    fid,
                    cast.get('data', {}).get('hash'),
                    cast.get('data', {}).get('castAddBody', {}).get('parentCastId', {}).get('hash') if cast.get('data', {}).get('castAddBody', {}).get('parentCastId') else None,
                    cast.get('data', {}).get('fid'),
                    cast.get('data', {}).get('castAddBody', {}).get('text', ''),
                    datetime.fromtimestamp(cast.get('data', {}).get('timestamp', 0))
                ))
            except Exception as e:
                print(f"Error inserting cast: {cast} {str(e)}")
    else:
        print(f"Error response: {response.text}")

def fetch_and_store_reactions(cur, fid):
    """Fetch and store reactions for a given FID"""
    url = f"{PINATA_API_URL}/reactionsByFid"
    reaction_types = ['Like', 'Recast','None']
    total_reactions = 0
    
    for reaction_type in reaction_types:
        print(f"\nFetching {reaction_type} for FID {fid}...")
        params = {
            'fid': fid,
            'reaction_type': reaction_type,
            'pageSize': 100000
        }
        
        while True:
            response = requests.get(url, headers=HEADERS, params=params)
            print(f"Response status code: {response.status_code}")
            
            if response.status_code == 200:
                data = response.json()
                reactions = data.get('messages', [])
                print(f"Found {len(reactions)} {reaction_type} in this page")
                total_reactions += len(reactions)
                
                for reaction in reactions:
                    try:
                        reaction_data = reaction.get('data', {})
                        reaction_body = reaction_data.get('reactionBody', {})
                        target_cast = reaction_body.get('targetCastId', {})
                        
                        cur.execute("""
                            INSERT INTO reactions (fid, target_fid, target_hash, type, timestamp)
                            VALUES (%s, %s, %s, %s, %s)
                            ON CONFLICT DO NOTHING
                        """, (
                            fid,
                            target_cast.get('fid'),
                            target_cast.get('hash'),
                            reaction_body.get('type'),
                            datetime.fromtimestamp(reaction_data.get('timestamp', 0))
                        ))
                    except Exception as e:
                        print(f"Error inserting reaction: {str(e)}")
                
                # Check for next page
                next_page_token = data.get('nextPageToken')
                if not next_page_token:
                    break
                    
                params['pageToken'] = next_page_token
            else:
                print(f"Error response: {response.text}")
                break
    
    print(f"Total reactions processed: {total_reactions}")

def fetch_and_store_verifications(cur, fid):
    """Fetch and store verifications for a given FID"""
    url = f"{PINATA_API_URL}/verificationsByFid"
    params = {
        'fid': fid,
        'pageSize': 100000
    }
    
    print(f"\nFetching verifications for FID {fid}...")
    total_verifications = 0
    
    while True:
        response = requests.get(url, headers=HEADERS, params=params)
        print(f"Response status code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            verifications = data.get('messages', [])
            print(f"Found {len(verifications)} verifications in this page")
            total_verifications += len(verifications)
            
            for verification in verifications:
                try:
                    verification_data = verification.get('data', {})
                    verification_body = verification_data.get('verificationAddEthAddressBody', {})
                    
                    cur.execute("""
                        INSERT INTO verifications (fid, address, timestamp, created_at)
                        VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                        ON CONFLICT DO NOTHING
                    """, (
                        fid,
                        verification_body.get('address'),
                        datetime.fromtimestamp(verification_data.get('timestamp', 0))
                    ))
                except Exception as e:
                    print(f"Error inserting verification: {str(e)}")
            
            # Check for next page
            next_page_token = data.get('nextPageToken')
            if not next_page_token:
                break
                
            params['pageToken'] = next_page_token
        else:
            print(f"Error response: {response.text}")
            break
    
    print(f"Total verifications processed: {total_verifications}")

def fetch_and_store_links(cur, fid):
    """Fetch and store links for a given FID"""
    url = f"{PINATA_API_URL}/linksByFid"
    params = {
        'fid': fid,
        'link_type': 'follow',  # Currently only 'follow' is available
        'pageSize': 100000
    }
    
    print(f"\nFetching links for FID {fid}...")
    total_links = 0
    
    while True:
        response = requests.get(url, headers=HEADERS, params=params)
        print(f"Response status code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            links = data.get('messages', [])
            print(f"Found {len(links)} links in this page")
            total_links += len(links)
            
            for link in links:
                try:
                    link_data = link.get('data', {})
                    link_body = link_data.get('linkBody', {})
                    
                    cur.execute("""
                        INSERT INTO links (fid, target_fid, type, timestamp, created_at)
                        VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                        ON CONFLICT DO NOTHING
                    """, (
                        fid,
                        link_body.get('targetFid'),
                        link_body.get('type'),
                        datetime.fromtimestamp(link_data.get('timestamp', 0))
                    ))
                except Exception as e:
                    print(f"Error inserting link: {str(e)}")
            
            # Check for next page
            next_page_token = data.get('nextPageToken')
            if not next_page_token:
                break
                
            params['pageToken'] = next_page_token
        else:
            print(f"Error response: {response.text}")
            break
    
    print(f"Total links processed: {total_links}")

def fetch_and_store_user_data(cur, fid):
    """Fetch and store user data for a given FID"""
    url = f"{PINATA_API_URL}/userDataByFid"
    user_data_types = [
        'USER_DATA_TYPE_PFP',
        'USER_DATA_TYPE_DISPLAY',
        'USER_DATA_TYPE_BIO',
        'USER_DATA_TYPE_URL',
        'USER_DATA_TYPE_USERNAME'
    ]
    total_user_data = 0
    
    for data_type in user_data_types:
        print(f"\nFetching {data_type} for FID {fid}...")
        params = {
            'fid': fid,
            'user_data_type': data_type,
            'pageSize': 100000
        }
        
        while True:
            response = requests.get(url, headers=HEADERS, params=params)
            print(f"Response status code: {response.status_code}")
            
            if response.status_code == 200:
                data = response.json()
                user_data = data.get('messages', [])
                print(f"Found {len(user_data)} {data_type} entries in this page")
                total_user_data += len(user_data)
                
                for entry in user_data:
                    try:
                        user_data_body = entry.get('data', {}).get('userDataBody', {})
                        
                        cur.execute("""
                            INSERT INTO user_data (fid, type, value, timestamp, created_at)
                            VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                            ON CONFLICT DO NOTHING
                        """, (
                            fid,
                            user_data_body.get('type'),
                            user_data_body.get('value'),
                            datetime.fromtimestamp(entry.get('data', {}).get('timestamp', 0))
                        ))
                    except Exception as e:
                        print(f"Error inserting user data: {str(e)}")
                
                # Check for next page
                next_page_token = data.get('nextPageToken')
                if not next_page_token:
                    break
                    
                params['pageToken'] = next_page_token
            else:
                print(f"Error response: {response.text}")
                break
    
    print(f"Total user data entries processed: {total_user_data}")

def main():
    # Create database tables
    create_database_tables()
    
    # Fetch all FIDs
    print("Fetching all FIDs...")
    fids = fetch_all_fids()
    print(f"Found {len(fids)} FIDs")
    
    # Process each FID
    for i, fid in enumerate(fids, 1):
        print(f"Processing FID {fid} ({i}/{len(fids)})")
        try:
            fetch_and_store_farcaster_data(fid)
            time.sleep(1)  # Rate limiting
        except Exception as e:
            print(f"Error processing FID {fid}: {str(e)}")
            continue

if __name__ == "__main__":
    main() 