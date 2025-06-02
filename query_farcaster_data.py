import psycopg2
import os
from dotenv import load_dotenv
from tabulate import tabulate
from datetime import datetime

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

def get_db_connection():
    """Create and return a database connection"""
    return psycopg2.connect(**DB_CONFIG)

def get_all_fids():
    """Get all FIDs in the database"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("SELECT fid, created_at FROM fids ORDER BY fid LIMIT 5")
    fids = cur.fetchall()
    
    cur.close()
    conn.close()
    
    print("\nTop 5 FIDs in database:")
    print(tabulate(fids, headers=['FID', 'Created At'], tablefmt='grid'))
    return fids

def get_user_casts(fid):
    """Get top 5 casts for a specific FID"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT hash, text, timestamp, parent_hash, author_fid 
        FROM casts 
        WHERE fid = %s 
        ORDER BY timestamp DESC
        LIMIT 5
    """, (fid,))
    casts = cur.fetchall()
    
    cur.close()
    conn.close()
    
    print(f"\nTop 5 Casts for FID {fid}:")
    print(tabulate(casts, headers=['Hash', 'Text', 'Timestamp', 'Parent Hash', 'Author FID'], tablefmt='grid'))
    return casts

def get_user_reactions(fid):
    """Get top 5 reactions for a specific FID"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT type, target_fid, target_hash, timestamp 
        FROM reactions 
        WHERE fid = %s 
        ORDER BY timestamp DESC
        LIMIT 5
    """, (fid,))
    reactions = cur.fetchall()
    
    cur.close()
    conn.close()
    
    print(f"\nTop 5 Reactions for FID {fid}:")
    print(tabulate(reactions, headers=['Type', 'Target FID', 'Target Hash', 'Timestamp'], tablefmt='grid'))
    return reactions

def get_user_verifications(fid):
    """Get top 5 verifications for a specific FID"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT address, timestamp 
        FROM verifications 
        WHERE fid = %s 
        ORDER BY timestamp DESC
        LIMIT 5
    """, (fid,))
    verifications = cur.fetchall()
    
    cur.close()
    conn.close()
    
    print(f"\nTop 5 Verifications for FID {fid}:")
    print(tabulate(verifications, headers=['Address', 'Timestamp'], tablefmt='grid'))
    return verifications

def get_user_links(fid):
    """Get top 5 links for a specific FID"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT type, target_fid, timestamp 
        FROM links 
        WHERE fid = %s 
        ORDER BY timestamp DESC
        LIMIT 5
    """, (fid,))
    links = cur.fetchall()
    
    cur.close()
    conn.close()
    
    print(f"\nTop 5 Links for FID {fid}:")
    print(tabulate(links, headers=['Type', 'Target FID', 'Timestamp'], tablefmt='grid'))
    return links

def get_user_data(fid):
    """Get top 5 user data entries for a specific FID"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT type, value, timestamp 
        FROM user_data 
        WHERE fid = %s 
        ORDER BY timestamp DESC
        LIMIT 5
    """, (fid,))
    user_data = cur.fetchall()
    
    cur.close()
    conn.close()
    
    print(f"\nTop 5 User Data entries for FID {fid}:")
    print(tabulate(user_data, headers=['Type', 'Value', 'Timestamp'], tablefmt='grid'))
    return user_data

def get_user_summary(fid):
    """Get a summary of all data for a specific FID"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    # Get counts for each type of data
    cur.execute("""
        SELECT 
            (SELECT COUNT(*) FROM casts WHERE fid = %s) as cast_count,
            (SELECT COUNT(*) FROM reactions WHERE fid = %s) as reaction_count,
            (SELECT COUNT(*) FROM verifications WHERE fid = %s) as verification_count,
            (SELECT COUNT(*) FROM links WHERE fid = %s) as link_count,
            (SELECT COUNT(*) FROM user_data WHERE fid = %s) as user_data_count
    """, (fid, fid, fid, fid, fid))
    
    summary = cur.fetchone()
    
    cur.close()
    conn.close()
    
    print(f"\nSummary for FID {fid}:")
    print(tabulate([summary], 
                  headers=['Casts', 'Reactions', 'Verifications', 'Links', 'User Data Items'],
                  tablefmt='grid'))
    return summary

def check_table_data():
    """Check the data in all tables"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    tables = ['fids', 'casts', 'reactions', 'verifications', 'links', 'user_data']
    
    print("\nTable Data Summary:")
    print("-" * 50)
    
    for table in tables:
        # Get count
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        count = cur.fetchone()[0]
        
        # Get sample data
        cur.execute(f"SELECT * FROM {table} LIMIT 1")
        sample = cur.fetchone()
        
        print(f"\n{table.upper()}:")
        print(f"Total records: {count}")
        if sample:
            print("Sample record:", sample)
        else:
            print("No records found")
    
    cur.close()
    conn.close()

def main():
    # First, check all table data
    check_table_data()
    
    # Then show the regular queries
    fids = get_all_fids()
    
    if not fids:
        print("No FIDs found in the database.")
        return
    
    # Get the first FID as an example
    example_fid = fids[0][0]
    
    # Show detailed data for the example FID
    get_user_summary(example_fid)
    get_user_casts(example_fid)
    get_user_reactions(example_fid)
    get_user_verifications(example_fid)
    get_user_links(example_fid)
    get_user_data(example_fid)

if __name__ == "__main__":
    main() 