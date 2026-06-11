import xmlrpc.client
import json
import hashlib
import os
import csv
import random
import string

URL      = "https://cubesteam-ardanoholding.odoo.com"
DB       = "cubesteam-ardanoholding-live-10270445"
USERNAME = "faisal@odoo.com"
API_KEY  = "ce88170b5bc46685ce2136db7796dc98b05f6359"
MERAAS_COMPANY_ID = 5
DB_FILE = "database.json"

def generate_random_password(length=8):
    # Generates a simple readable random password
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))

def main():
    print("Connecting to Odoo...")
    common = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/common")
    uid = common.authenticate(DB, USERNAME, API_KEY, {})
    models = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/object")
    print("Connected successfully.")

    # 1. Fetch all unique contractor_ids using read_group
    print("Fetching contractors and task counts from Odoo...")
    groups = models.execute_kw(DB, uid, API_KEY, 'project.task', 'read_group',
                              [
                                  [('company_id', '=', MERAAS_COMPANY_ID), ('contractor_id', '!=', False)],
                                  ['contractor_id'],
                                  ['contractor_id']
                              ])
    
    contractor_ids = []
    wo_counts = {}
    for g in groups:
        c_val = g.get('contractor_id')
        if c_val:
            cid = c_val[0]
            contractor_ids.append(cid)
            wo_counts[cid] = g.get('contractor_id_count', 0)

    print(f"Found {len(contractor_ids)} contractors with active work orders.")

    if not contractor_ids:
        print("No contractors found.")
        return

    # 2. Fetch details for these partners
    print("Fetching partner details (names, emails, phones)...")
    partners = models.execute_kw(DB, uid, API_KEY, 'res.partner', 'search_read',
                                 [[('id', 'in', contractor_ids)]],
                                 {'fields': ['id', 'name', 'email', 'phone']})
    print(f"Retrieved details for {len(partners)} partners.")

    # 3. Load existing database
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r", encoding="utf-8") as f:
            db = json.load(f)
    else:
        db = {"users": {}, "mappings": {}}

    # Create a mapping of partner_id -> email for quick lookup of existing users
    existing_mappings = {}
    for email, u in db["users"].items():
        if u.get("role") == "contractor" and u.get("partner_id"):
            existing_mappings[u["partner_id"]] = (email, u["password"]) # store email and pass hash

    # Prepare list for CSV export
    csv_data = []

    # Map partners
    new_mappings_count = 0
    existing_mappings_count = 0

    print("Mapping contractors and generating accounts...")
    for p in partners:
        pid = p["id"]
        pname = p["name"]
        p_odoo_email = p["email"]
        po_cnt = wo_counts.get(pid, 0)

        # Check if already mapped
        if pid in existing_mappings:
            email, pass_hash = existing_mappings[pid]
            # Since password is encrypted in JSON, we can't show plain text unless we know it.
            # We'll note that the password is already set (or show a placeholder)
            plain_password = "[كلمة المرور الحالية مسجلة مسبقاً]"
            existing_mappings_count += 1
        else:
            # Generate email
            # Fallback pattern if partner has no email: c{id}@meraas-portal.ly
            email = p_odoo_email
            if not email or "@" not in email or email.strip().lower() in db["users"]:
                email = f"c{pid}@meraas-portal.ly"
            
            email = email.strip().lower()
            
            # Generate password
            plain_password = generate_random_password(6)
            pass_hash = hashlib.sha256(plain_password.encode()).hexdigest()

            # Save to database
            db["users"][email] = {
                "role": "contractor",
                "password": pass_hash,
                "partner_id": pid,
                "name": pname
            }
            new_mappings_count += 1

        csv_data.append({
            "اسم المقاول في أودو": pname,
            "معرف المقاول (Odoo ID)": pid,
            "البريد الإلكتروني للدخول": email,
            "كلمة المرور": plain_password,
            "عدد أوامر العمل": po_cnt
        })

    # Save database
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
    print(f"Database saved. New users created: {new_mappings_count}, Existing users retained: {existing_mappings_count}.")

    # Write CSV
    csv_file = "contractors_accounts.csv"
    fields = ["اسم المقاول في أودو", "معرف المقاول (Odoo ID)", "البريد الإلكتروني للدخول", "كلمة المرور", "عدد أوامر العمل"]
    
    with open(csv_file, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(csv_data)

    print(f"Excel-compatible CSV file successfully written to: {os.path.abspath(csv_file)}")
    print("Done!")

if __name__ == "__main__":
    main()
