"""
MERAAS Contractor Tracker - Backend Server
Runs a lightweight built-in HTTP server to serve static files and XML-RPC Odoo proxy API.
Includes memory caching for high performance.
"""
import http.server
import socketserver
import urllib.parse
import json
import xmlrpc.client
import os
import hashlib
import time
from datetime import datetime
import threading

PORT = 8000
DB_FILE = "database.json"
odoo_lock = threading.Lock()

# ─── ODOO CONFIG ──────────────────────────────────────────────────────────────
ODOO_URL  = "https://cubesteam-ardanoholding.odoo.com"
ODOO_DB   = "cubesteam-ardanoholding-live-10270445"
ODOO_USER = "faisal@odoo.com"
ODOO_KEY  = "ce88170b5bc46685ce2136db7796dc98b05f6359"
# ────────────────────────────────────────────────────────────────────────────────

# Global memory cache
# Structure: { key: { "data": data, "timestamp": time.time() } }
CACHE_TTL = 300  # Cache lasts 5 minutes
cache = {}

# Default admin credentials
ADMIN_EMAIL = "admin@meraas.ly"
ADMIN_PASS_HASH = hashlib.sha256("admin123".encode()).hexdigest()

def get_cache(key):
    if key in cache:
        entry = cache[key]
        if time.time() - entry["timestamp"] < CACHE_TTL:
            return entry["data"]
    return None

def set_cache(key, data):
    cache[key] = {
        "data": data,
        "timestamp": time.time()
    }

def clear_cache():
    global cache
    cache = {}

# Ensure local JSON database exists
if not os.path.exists(DB_FILE):
    initial_db = {
        "users": {
            ADMIN_EMAIL: {
                "role": "admin",
                "password": ADMIN_PASS_HASH,
                "partner_id": None,
                "name": "Admin (MERAAS)"
            }
        },
        "mappings": {}  # email -> partner_id
    }
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(initial_db, f, indent=2)

def load_db():
    with open(DB_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_db(data):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def connect_odoo():
    try:
        common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
        uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_KEY, {})
        if not uid:
            return None, None
        models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
        return uid, models
    except Exception as e:
        print(f"Odoo Connection Error: {e}")
        return None, None

def get_approval_bill_date(app_id, approval_rec, approval_to_bill):
    # Find linked moves
    moves = approval_to_bill.get(app_id, [])
    if not moves:
        # Fallback to date_confirmed or create_date
        raw_date = approval_rec.get('date_confirmed') or approval_rec.get('create_date') or ""
        if raw_date:
            return raw_date.split(' ')[0]
        return None
        
    dates = []
    for m in moves:
        # Check for payments reconciled in payments widget
        widget = m.get('invoice_payments_widget')
        widget_data = None
        if isinstance(widget, str) and widget:
            try:
                widget_data = json.loads(widget)
            except Exception:
                pass
        elif isinstance(widget, dict):
            widget_data = widget
            
        payment_dates = []
        if widget_data and isinstance(widget_data, dict) and 'content' in widget_data:
            for item in widget_data['content']:
                p_date = item.get('date')
                if p_date:
                    payment_dates.append(str(p_date))
                    
        if payment_dates:
            dates.append(max(payment_dates))
        else:
            # Fallback to invoice_date or date
            inv_date = m.get('invoice_date') or m.get('date')
            if inv_date:
                dates.append(str(inv_date))
                
    if dates:
        return max(dates)
    return None

def fetch_odoo_data_for_partner(partner_id=None):
    if not partner_id:
        return {"error": "Contractor ID is required"}
        
    cache_key = f"raw_orders_{partner_id}"
    cached = get_cache(cache_key)
    if cached:
        return cached

    with odoo_lock:
        # Check again under lock to prevent double Odoo calls
        cached = get_cache(cache_key)
        if cached:
            return cached
            
        uid, models = connect_odoo()
        if not uid:
            return {"error": "Odoo connection failed"}
        
        # 1. Build project.task domain
        # Filter by company_id = 5 (MERAAS) and check if contractor is logged in
        domain = [('company_id', '=', 5), ('contractor_id', '=', int(partner_id))]
        
    try:
        # 2. Fetch tasks (including analytic_account_id)
        tasks = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'project.task', 'search_read',
                                  [domain],
                                  {'fields': [
                                      'name', 'work_order_number', 'task_type_work_order',
                                      'project_location', 'cost_center_number', 'bill_number',
                                      'vendor_reference', 'total_points', 'total_payment',
                                      'total_payment_request', 'total_commitment', 'date',
                                      'write_date', 'contractor_id', 'approval_requests', 'payment_ids',
                                      'analytic_account_id'
                                  ]})
    except Exception as e:
        print(f"Error fetching tasks from Odoo: {e}")
        return {"error": f"Failed to fetch tasks: {e}"}

    # 3. Collect approval and milestone IDs
    approval_ids = []
    milestone_ids = []
    for t in tasks:
        approval_ids.extend(t.get('approval_requests', []))
        milestone_ids.extend(t.get('payment_ids', []))
        
    approval_ids = list(set(approval_ids))
    milestone_ids = list(set(milestone_ids))

    # 4. Fetch approval requests in batch (with total_pre_discount and create_date)
    approvals_dict = {}
    if approval_ids:
        try:
            approvals = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'approval.request', 'search_read',
                                          [[('id', 'in', approval_ids)]],
                                          {'fields': [
                                              'id', 'name', 'payment_status', 'request_status', 
                                              'total_paid', 'date_confirmed', 'total_pre_discount', 'create_date'
                                          ]})
            for app in approvals:
                approvals_dict[app['id']] = app
        except Exception as e:
            print(f"Error batch fetching approvals: {e}")

    # 5. Fetch account.move (vendor bills) linked to approvals in batch
    approval_to_bill = {}
    if approval_ids:
        try:
            moves = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'account.move', 'search_read',
                                      [[('approval_request_ids', 'in', approval_ids)]],
                                      {'fields': [
                                          'id', 'name', 'payment_state', 'date', 
                                          'invoice_date', 'invoice_payments_widget', 'approval_request_ids'
                                      ]})
            for m in moves:
                for app_id in m.get('approval_request_ids', []):
                    if app_id not in approval_to_bill:
                        approval_to_bill[app_id] = []
                    approval_to_bill[app_id].append(m)
        except Exception as e:
            print(f"Error batch fetching moves: {e}")

    # 6. Fetch milestone payment terms in batch
    milestones_dict = {}
    if milestone_ids:
        try:
            milestones = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'task.payment', 'search_read',
                                           [[('id', 'in', milestone_ids)]],
                                           {'fields': ['id', 'payment_number', 'payment', 'input_val', 'output_val', 'payment_term', 'payment_type', 'notes']})
            for ms in milestones:
                milestones_dict[ms['id']] = ms
        except Exception as e:
            print(f"Error batch fetching milestones: {e}")

    # 7. Aggregate data
    aggregated_pos = []
    state_map = {
        'draft': 'مسودة',
        'approved': 'معتمد',
        'confirm': 'مؤكد',
        'cancel': 'ملغي'
    }

    for t in tasks:
        raw_apps = [approvals_dict[aid] for aid in t.get('approval_requests', []) if aid in approvals_dict]
        t_milestones = [milestones_dict[mid] for mid in t.get('payment_ids', []) if mid in milestones_dict]

        # Sort approvals chronologically by ID
        sorted_apps = sorted(raw_apps, key=lambda x: x.get('id') or 0)

        paid_refs = []
        under_proc_refs = []
        
        paid_app_dates = []
        under_proc_app_dates = []

        total_wo_value = t['total_points'] or 0.0
        paid_amount = t['total_payment'] or 0.0
        under_process_amount = max(0.0, (t['total_payment_request'] or 0.0) - (t['total_payment'] or 0.0))
        remaining_amount = t['total_commitment'] or 0.0

        t_apps = []
        running_sum = 0.0
        for app in sorted_apps:
            name = app.get('name')
            app_id = app.get('id')
            app_amount = app.get('total_pre_discount') or 0.0
            
            if app.get('request_status') == 'cancel':
                app_rec = dict(app)
                app_rec['payment_date'] = get_approval_bill_date(app_id, app, approval_to_bill)
                app_rec['is_paid'] = False
                t_apps.append(app_rec)
                continue
                
            app_date = get_approval_bill_date(app_id, app, approval_to_bill)
            
            running_sum += app_amount
            is_paid = (running_sum <= paid_amount + 1.0)
            
            app_rec = dict(app)
            app_rec['payment_date'] = app_date
            app_rec['is_paid'] = is_paid
            t_apps.append(app_rec)
            
            if is_paid:
                paid_refs.append(name)
                if app_date:
                    paid_app_dates.append(app_date)
            else:
                under_proc_refs.append(name)
                if app_date:
                    under_proc_app_dates.append(app_date)

        latest_paid_date = max(paid_app_dates) if paid_app_dates else "-"
        latest_under_proc_date = max(under_proc_app_dates) if under_proc_app_dates else "-"

        # Cost Center Name extraction
        analytic = t.get('analytic_account_id')
        cost_center_name = "غير حدد"
        if analytic and isinstance(analytic, (list, tuple)) and len(analytic) > 1:
            raw_name = analytic[1]
            if raw_name:
                if ']' in raw_name:
                    cost_center_name = raw_name.split(']', 1)[1].strip()
                else:
                    cost_center_name = raw_name
        elif t.get('cost_center_number'):
            cost_center_name = t['cost_center_number']

        aggregated_pos.append({
            'id': t['id'],
            'po_number': t['name'],
            'wo_number': t['work_order_number'] or t['name'],
            'state': state_map.get(t['task_type_work_order'], t['task_type_work_order'] or 'مسودة'),
            'location': t['project_location'][1] if t['project_location'] else "غير حدد",
            'cost_center': cost_center_name,
            'invoice_no': t['bill_number'] if t['bill_number'] else "-",
            'vendor_reference': t['vendor_reference'] or False,
            'total_amount': total_wo_value,
            'under_process_amount': under_process_amount,
            'paid_amount': paid_amount,
            'remaining_amount': remaining_amount,
            'date': t['date'] or "-",
            'under_process_date': latest_under_proc_date,
            'paid_date': latest_paid_date,
            'write_date': t['write_date'] or "-",
            'contractor_name': t['contractor_id'][1] if t['contractor_id'] else "غير محدد",
            'paid_payment_refs': paid_refs,
            'under_process_payment_refs': under_proc_refs,
            'approvals': t_apps,
            'milestones': t_milestones
        })

    set_cache(cache_key, aggregated_pos)
    return aggregated_pos

class ContractorTrackerHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "OK")
        self.end_headers()

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        path = parsed_path.path
        query = urllib.parse.parse_qs(parsed_path.query)

        # ─── API ENDPOINTS ───────────────────────────────────────────────────
        if path.startswith("/api/"):
            self.handle_api_get(path, query)
            return
            
        # Serve static files from 'public' directory
        if path == "/":
            self.path = "/public/index.html"
        else:
            self.path = "/public" + path
            
        # Check if file exists, if not serve index.html for SPA router
        full_filepath = os.getcwd() + self.path.replace('/', os.sep)
        if not os.path.exists(full_filepath) or os.path.isdir(full_filepath):
            self.path = "/public/index.html"

        super().do_GET()

    def do_POST(self):
        parsed_path = urllib.parse.urlparse(self.path)
        path = parsed_path.path

        if path.startswith("/api/"):
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                body = json.loads(post_data.decode('utf-8'))
            except Exception:
                body = {}
            self.handle_api_post(path, body)
            return

        self.send_response(404)
        self.end_headers()

    # ─── GET ROUTER ──────────────────────────────────────────────────────────
    def handle_api_get(self, path, query):
        token = self.headers.get('Authorization', '').replace('Bearer ', '')
        user = self.get_user_by_token(token)
        
        if not user:
            self.send_json({"error": "Unauthorized"}, 401)
            return

        if path == "/api/dashboard":
            self.get_dashboard(user, query)
        elif path == "/api/work_orders":
            self.get_work_orders(user, query)
        elif path == "/api/contractors" and user["role"] == "admin":
            self.get_contractors()
        else:
            self.send_json({"error": "Not Found"}, 404)

    # ─── POST ROUTER ─────────────────────────────────────────────────────────
    def handle_api_post(self, path, body):
        if path == "/api/login":
            self.login(body)
        elif path == "/api/setup-password":
            self.setup_password(body)
        elif path == "/api/contractors/map":
            token = self.headers.get('Authorization', '').replace('Bearer ', '')
            user = self.get_user_by_token(token)
            if not user or user["role"] != "admin":
                self.send_json({"error": "Unauthorized"}, 401)
                return
            self.map_contractor(body)
        else:
            self.send_json({"error": "Not Found"}, 404)

    # ─── HANDLERS ────────────────────────────────────────────────────────────
    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        response_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_header('Content-Length', len(response_bytes))
        self.end_headers()
        self.wfile.write(response_bytes)

    def get_user_by_token(self, token):
        if not token:
            return None
        db = load_db()
        for email, u in db["users"].items():
            # Simple token scheme: sha256 of email + password
            expected_token = hashlib.sha256(f"{email}:{u['password']}".encode()).hexdigest()
            if token == expected_token:
                return {"email": email, "role": u["role"], "partner_id": u.get("partner_id"), "name": u["name"]}
        return None

    def login(self, body):
        email = body.get("email", "").strip().lower()
        password = body.get("password", "").strip()

        if not email or not password:
            self.send_json({"error": "Email and password are required"}, 400)
            return

        db = load_db()
        if email in db["users"]:
            u = db["users"][email]
            pass_hash = hashlib.sha256(password.encode()).hexdigest()
            if u["password"] == pass_hash:
                token = hashlib.sha256(f"{email}:{pass_hash}".encode()).hexdigest()
                self.send_json({
                    "token": token,
                    "role": u["role"],
                    "name": u["name"],
                    "email": email
                })
                return

        self.send_json({"error": "البريد الإلكتروني أو كلمة المرور غير صحيحة"}, 401)

    def setup_password(self, body):
        email = body.get("email", "").strip().lower()
        password = body.get("password", "").strip()

        if not email or not password:
            self.send_json({"error": "Email and password are required"}, 400)
            return

        uid, models = connect_odoo()
        if not uid:
            self.send_json({"error": "فشل الاتصال بـ Odoo"}, 500)
            return

        # Check if the email exists in res.partner
        partners = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'res.partner', 'search_read',
                                     [[['email', '=', email]]],
                                     {'fields': ['id', 'name']})
        if not partners:
            self.send_json({"error": "هذا البريد الإلكتروني غير مسجل كمقاول في Odoo"}, 400)
            return

        partner = partners[0]
        db = load_db()
        
        # Save password
        pass_hash = hashlib.sha256(password.encode()).hexdigest()
        db["users"][email] = {
            "role": "contractor",
            "password": pass_hash,
            "partner_id": partner["id"],
            "name": partner["name"]
        }
        save_db(db)
        
        token = hashlib.sha256(f"{email}:{pass_hash}".encode()).hexdigest()
        self.send_json({
            "token": token,
            "role": "contractor",
            "name": partner["name"],
            "email": email
        })

    def get_dashboard(self, user, query=None):
        partner_id = user["partner_id"]
        # If admin and partner_id is in query, use it
        if user["role"] == "admin":
            p_id_list = query.get("partner_id") if query else None
            if p_id_list and p_id_list[0]:
                partner_id = p_id_list[0]
            else:
                # Admin has not selected a contractor, return empty stats immediately
                data = {
                    "total_orders": 0,
                    "draft_count": 0,
                    "confirmed_count": 0,
                    "completed_count": 0,
                    "total_value": 0.0,
                    "total_paid": 0.0,
                    "total_under_process": 0.0,
                    "total_remaining": 0.0,
                    "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
                self.send_json(data)
                return

        cache_key = f"dashboard_{partner_id or 'admin'}"
        cached = get_cache(cache_key)
        if cached:
            self.send_json(cached)
            return

        orders = fetch_odoo_data_for_partner(partner_id)
        if "error" in orders:
            self.send_json(orders, 500)
            return

        total_orders = len(orders)
        draft_count = sum(1 for o in orders if o["state"] == "مسودة")
        confirmed_count = sum(1 for o in orders if o["state"] == "مؤكد")
        completed_count = sum(1 for o in orders if o["state"] == "معتمد")
        
        total_val = sum(o["total_amount"] for o in orders)
        total_paid = sum(o["paid_amount"] for o in orders)
        total_under_proc = sum(o["under_process_amount"] for o in orders)
        total_rem = sum(o["remaining_amount"] for o in orders)

        data = {
            "total_orders": total_orders,
            "draft_count": draft_count,
            "confirmed_count": confirmed_count,
            "completed_count": completed_count,
            "total_value": total_val,
            "total_paid": total_paid,
            "total_under_process": total_under_proc,
            "total_remaining": total_rem,
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        set_cache(cache_key, data)
        self.send_json(data)

    def get_work_orders(self, user, query=None):
        partner_id = user["partner_id"]
        if user["role"] == "admin":
            p_id_list = query.get("partner_id") if query else None
            if p_id_list and p_id_list[0]:
                partner_id = p_id_list[0]
            else:
                # Admin has not selected a contractor, return empty list immediately
                self.send_json([])
                return

        cache_key = f"orders_{partner_id or 'admin'}"
        cached = get_cache(cache_key)
        if cached:
            self.send_json(cached)
            return

        orders = fetch_odoo_data_for_partner(partner_id)
        if "error" in orders:
            self.send_json(orders, 500)
            return

        set_cache(cache_key, orders)
        self.send_json(orders)

    def get_contractors(self):
        cache_key = "all_contractors"
        cached = get_cache(cache_key)
        if cached:
            self.send_json(cached)
            return

        uid, models = connect_odoo()
        if not uid:
            self.send_json({"error": "Failed to connect to Odoo"}, 500)
            return

        try:
            # Find all unique contractor_ids from tasks of MERAAS (company 5) using read_group for speed
            groups = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'project.task', 'read_group',
                                      [
                                          [('company_id', '=', 5), ('contractor_id', '!=', False)],
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
            
            if not contractor_ids:
                self.send_json([])
                return
                
            partners = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'res.partner', 'search_read',
                                         [[('id', 'in', contractor_ids)]],
                                         {'fields': ['id', 'name', 'email', 'phone']})
                    
            db = load_db()
            mapped_emails = {u.get("partner_id"): email for email, u in db["users"].items() if u["role"] == "contractor"}

            result = []
            for p in partners:
                result.append({
                    "id": p["id"],
                    "name": p["name"],
                    "odoo_email": p["email"] or "غير محدد",
                    "phone": p["phone"] or "-",
                    "registered_email": mapped_emails.get(p["id"], "غير مسجل بعد"),
                    "po_count": wo_counts.get(p["id"], 0)
                })

            set_cache(cache_key, result)
            self.send_json(result)
        except Exception as e:
            self.send_json({"error": f"Failed to fetch contractors: {e}"}, 500)

    def map_contractor(self, body):
        partner_id = body.get("partner_id")
        email = body.get("email", "").strip().lower()
        password = body.get("password", "123456").strip() # default pass

        if not partner_id or not email:
            self.send_json({"error": "Partner ID and Email are required"}, 400)
            return

        uid, models = connect_odoo()
        if not uid:
            self.send_json({"error": "Odoo connection failed"}, 500)
            return

        partners = models.execute_kw(ODOO_DB, uid, ODOO_KEY, 'res.partner', 'search_read',
                                     [[['id', '=', int(partner_id)]]],
                                     {'fields': ['id', 'name']})
        if not partners:
            self.send_json({"error": "Partner not found in Odoo"}, 404)
            return

        partner = partners[0]
        db = load_db()
        pass_hash = hashlib.sha256(password.encode()).hexdigest()
        
        db["users"][email] = {
            "role": "contractor",
            "password": pass_hash,
            "partner_id": partner["id"],
            "name": partner["name"]
        }
        save_db(db)
        clear_cache()
        self.send_json({"success": True, "message": f"Mapped {email} to {partner['name']}"})

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    # Fix console coding for windows prints
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    os.makedirs("public", exist_ok=True)
    os.makedirs("public/css", exist_ok=True)
    os.makedirs("public/js", exist_ok=True)

    print(f"Starting server on http://localhost:{PORT}")
    with ThreadingHTTPServer(("", PORT), ContractorTrackerHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
