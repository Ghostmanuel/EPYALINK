import os, sqlite3, hashlib, hmac, secrets, math, json, uuid, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import jwt
from fastapi import FastAPI, HTTPException, Depends, Header, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv('DATABASE_PATH', BASE / 'epyalink.db'))
UPLOADS = BASE / 'static' / 'uploads'
UPLOADS.mkdir(parents=True, exist_ok=True)
SECRET = os.getenv('SECRET_KEY', 'EPYALINK-DEMO-CHANGE-THIS-SECRET')
JWT_ALG = 'HS256'
COMMISSION_RATE = float(os.getenv('COMMISSION_RATE', '0.04'))
TRANSPORT_RATE_KM = float(os.getenv('TRANSPORT_RATE_KM', '75'))
TRANSPORT_RATE_KG = float(os.getenv('TRANSPORT_RATE_KG', '8'))
TRANSPORT_BASE = float(os.getenv('TRANSPORT_BASE', '5000'))
ROUTING_URL = os.getenv('ROUTING_URL', 'https://router.project-osrm.org')

app = FastAPI(title='EPYALINK', version='3.1.0')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])

ROLES = {'buyer','seller','supplier','transporter','transport_company','admin'}

SCHEMA = '''
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL, province TEXT, municipality TEXT,
 company_name TEXT, farm_name TEXT, photo TEXT, verified INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
 rating REAL DEFAULT 0, reviews INTEGER DEFAULT 0, completed_sales INTEGER DEFAULT 0,
 completed_deliveries INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
 product_type TEXT NOT NULL DEFAULT 'production', price_kz REAL NOT NULL, quantity REAL NOT NULL,
 unit TEXT NOT NULL, weight_kg REAL NOT NULL, province TEXT NOT NULL, municipality TEXT, farm TEXT,
 photo TEXT, description TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(seller_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id INTEGER NOT NULL, seller_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
 quantity REAL NOT NULL, weight_kg REAL NOT NULL, product_total_kz REAL NOT NULL, origin_province TEXT,
 destination_province TEXT, destination_municipality TEXT, distance_km REAL DEFAULT 0, transport_fee_kz REAL DEFAULT 0,
 service_fee_kz REAL DEFAULT 0, total_kz REAL NOT NULL, transport_mode TEXT DEFAULT 'epyalink',
 status TEXT DEFAULT 'PENDING_SELLER', payment_status TEXT DEFAULT 'PENDING', delivery_status TEXT DEFAULT 'PENDING',
 delivery_pin TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transporters(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, vehicle_type TEXT, plate TEXT, capacity_kg REAL DEFAULT 0,
 available INTEGER DEFAULT 1, latitude REAL, longitude REAL, FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS deliveries(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER UNIQUE NOT NULL, transporter_id INTEGER,
 status TEXT DEFAULT 'REQUESTED', started_at TEXT, delivered_at TEXT, proof_photo TEXT,
 latitude REAL, longitude REAL, FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS payments(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER UNIQUE NOT NULL, method TEXT NOT NULL,
 reference TEXT, amount_kz REAL NOT NULL, status TEXT DEFAULT 'PENDING', commission_kz REAL DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
 body TEXT NOT NULL, attachment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ratings(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, from_user INTEGER NOT NULL,
 to_user INTEGER NOT NULL, score INTEGER NOT NULL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id, from_user, to_user)
);
CREATE TABLE IF NOT EXISTS disputes(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, opened_by INTEGER NOT NULL,
 reason TEXT NOT NULL, evidence TEXT, status TEXT DEFAULT 'OPEN', resolution TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS favorites(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
 UNIQUE(user_id,kind,target_id)
);
CREATE TABLE IF NOT EXISTS audit(
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id INTEGER,
 details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
'''

def db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    return c

def init_db():
    c=db(); c.executescript(SCHEMA)
    defaults={'transport_rate_km':str(TRANSPORT_RATE_KM),'transport_rate_kg':str(TRANSPORT_RATE_KG),'transport_base':str(TRANSPORT_BASE),'commission_rate':str(COMMISSION_RATE)}
    for k,v in defaults.items(): c.execute('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',(k,v))
    admin_phone=os.getenv('ADMIN_PHONE','999999999'); admin_pass=os.getenv('ADMIN_PASSWORD','Admin@12345')
    if not c.execute('SELECT id FROM users WHERE phone=?',(admin_phone,)).fetchone():
        c.execute('INSERT INTO users(full_name,phone,password_hash,role,province,verified) VALUES(?,?,?,?,?,1)',('Administrador EPYALINK',admin_phone,hash_password(admin_pass),'admin','Huambo'))
    c.commit(); c.close()

def hash_password(p):
    salt=secrets.token_bytes(16); dk=hashlib.pbkdf2_hmac('sha256',p.encode(),salt,220000)
    return salt.hex()+':'+dk.hex()

def check_password(p,stored):
    try:
        salt, val=stored.split(':',1); dk=hashlib.pbkdf2_hmac('sha256',p.encode(),bytes.fromhex(salt),220000); return hmac.compare_digest(dk.hex(),val)
    except Exception: return False

def token(user_id,role):
    now=datetime.now(timezone.utc); return jwt.encode({'sub':str(user_id),'role':role,'iat':now,'exp':now+timedelta(hours=12)},SECRET,algorithm=JWT_ALG)

def auth(authorization: str=Header(default='')):
    if not authorization.startswith('Bearer '): raise HTTPException(401,'Faça login para continuar.')
    try: p=jwt.decode(authorization[7:],SECRET,algorithms=[JWT_ALG]); uid=int(p['sub'])
    except Exception: raise HTTPException(401,'Sessão inválida ou expirada.')
    c=db(); u=c.execute('SELECT * FROM users WHERE id=? AND status="active"',(uid,)).fetchone(); c.close()
    if not u: raise HTTPException(401,'Conta indisponível.')
    return dict(u)

def require(*roles):
    def dep(u=Depends(auth)):
        if u['role'] not in roles: raise HTTPException(403,'Permissão insuficiente.')
        return u
    return dep

def audit(c,actor,action,entity=None,eid=None,details=None): c.execute('INSERT INTO audit(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)',(actor,action,entity,eid,json.dumps(details or {},ensure_ascii=False)))
def notify(c,uid,title,body): c.execute('INSERT INTO notifications(user_id,title,body) VALUES(?,?,?)',(uid,title,body))

def distance_estimate(origin, dest):
    origin=(origin or '').strip(); dest=(dest or '').strip()
    if not origin or not dest: return 0.0
    if origin.lower()==dest.lower(): return 0.0
    known={'Huambo-Luanda':670,'Luanda-Huambo':670,'Huambo-Benguela':420,'Benguela-Huambo':420,'Huambo-Malanje':520,'Malanje-Huambo':520,'Huambo-Cuanza Sul':390,'Cuanza Sul-Huambo':390}
    key=f'{origin}-{dest}'
    if key in known: return float(known[key])
    # Try road routing when the service is reachable; fall back to a deterministic estimate.
    try:
        q1=urllib.parse.quote(origin+', Angola'); q2=urllib.parse.quote(dest+', Angola')
        geo=[]
        for q in (q1,q2):
            req=urllib.request.Request(f'https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=1',headers={'User-Agent':'EPYALINK/3.1'})
            with urllib.request.urlopen(req,timeout=4) as r: data=json.loads(r.read().decode())
            if not data: raise RuntimeError('geocode')
            geo.append((float(data[0]['lon']),float(data[0]['lat'])))
        url=f"{ROUTING_URL.rstrip('/')}/route/v1/driving/{geo[0][0]},{geo[0][1]};{geo[1][0]},{geo[1][1]}?overview=false"
        req=urllib.request.Request(url,headers={'User-Agent':'EPYALINK/3.1'})
        with urllib.request.urlopen(req,timeout=7) as r: data=json.loads(r.read().decode())
        route=(data.get('routes') or [None])[0]
        if route: return round(route['distance']/1000,2)
    except Exception:
        pass
    return 250.0

def calc_transport(weight, distance, vehicle_factor=1.0):
    c=db(); vals={r['key']:float(r['value']) for r in c.execute('SELECT key,value FROM settings').fetchall()}; c.close()
    base=vals.get('transport_base',TRANSPORT_BASE); km=vals.get('transport_rate_km',TRANSPORT_RATE_KM); kg=vals.get('transport_rate_kg',TRANSPORT_RATE_KG)
    return round((base+distance*km+weight*kg)*max(1.0,float(vehicle_factor)),2)

class RegisterIn(BaseModel):
    full_name:str; phone:str; password:str=Field(min_length=6); role:str='buyer'; province:str=''; municipality:str=''; company_name:str=''; farm_name:str=''
class LoginIn(BaseModel): phone:str; password:str
class ProductIn(BaseModel):
    name:str; category:str; product_type:str='production'; price_kz:float=Field(gt=0); quantity:float=Field(gt=0); unit:str='kg'; weight_kg:float=Field(gt=0); province:str; municipality:str=''; farm:str=''; description:str=''
class OrderIn(BaseModel):
    product_id:int; quantity:float=Field(gt=0); destination_province:str; destination_municipality:str=''; transport_mode:str='epyalink'
class PaymentIn(BaseModel): method:str; reference:str=''
class SellerDecision(BaseModel): accepted:bool
class TransportChoice(BaseModel): mode:str
class AssignTransport(BaseModel): transporter_id:int
class RatingIn(BaseModel): score:int=Field(ge=1,le=5); comment:str=''
class DisputeIn(BaseModel): reason:str; evidence:str=''
class SettingIn(BaseModel): value:str
class StatusIn(BaseModel): status:str
class MessageIn(BaseModel): body:str

@app.on_event('startup')
def startup(): init_db()

@app.get('/')
def home(): return FileResponse(BASE/'index.html')
@app.get('/manifest.json')
def manifest(): return FileResponse(BASE/'manifest.json')
@app.get('/health')
def health(): return {'status':'ok','app':'EPYALINK','version':'3.1.0'}

@app.post('/api/auth/register')
def register(x:RegisterIn):
    if x.role not in ROLES-{ 'admin' }: raise HTTPException(400,'Tipo de conta inválido.')
    c=db()
    if c.execute('SELECT id FROM users WHERE phone=?',(x.phone.strip(),)).fetchone(): c.close(); raise HTTPException(409,'Telefone já registado.')
    cur=c.execute('INSERT INTO users(full_name,phone,password_hash,role,province,municipality,company_name,farm_name) VALUES(?,?,?,?,?,?,?,?)',(x.full_name.strip(),x.phone.strip(),hash_password(x.password),x.role,x.province,x.municipality,x.company_name,x.farm_name)); uid=cur.lastrowid
    audit(c,uid,'USER_REGISTERED','users',uid,{'role':x.role}); c.commit(); u=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone(); c.close()
    return {'token':token(uid,x.role),'user':public_user(u)}

@app.post('/api/auth/login')
def login(x:LoginIn):
    c=db(); u=c.execute('SELECT * FROM users WHERE phone=?',(x.phone.strip(),)).fetchone()
    if not u or not check_password(x.password,u['password_hash']): c.close(); raise HTTPException(401,'Telefone ou palavra-passe incorretos.')
    audit(c,u['id'],'LOGIN'); c.commit(); c.close(); return {'token':token(u['id'],u['role']),'user':public_user(u)}

@app.post('/api/auth/logout')
def logout(u=Depends(auth)): return {'ok':True}

@app.get('/api/me')
def me(u=Depends(auth)):
    c=db(); r=c.execute('SELECT * FROM users WHERE id=?',(u['id'],)).fetchone(); c.close(); return public_user(r)

def public_user(u):
    d=dict(u); d.pop('password_hash',None); return d

@app.post('/api/files/profile-photo')
def profile_photo(file:UploadFile=File(...),u=Depends(auth)):
    raw=file.file.read();
    if len(raw)>5*1024*1024 or not file.content_type.startswith('image/'): raise HTTPException(400,'Imagem inválida ou maior que 5 MB.')
    name=f'{uuid.uuid4().hex}{Path(file.filename or "photo.jpg").suffix.lower() or ".jpg"}'; (UPLOADS/name).write_bytes(raw)
    url='/static/uploads/'+name; c=db(); c.execute('UPDATE users SET photo=? WHERE id=?',(url,u['id'])); audit(c,u['id'],'PROFILE_PHOTO_UPDATED','users',u['id']); c.commit(); c.close(); return {'photo':url}

@app.get('/api/categories')
def categories():
    return ['Produção agrícola','Sementes','Fertilizantes','Adubos','Irrigação','Ferramentas','Máquinas agrícolas','Equipamentos','Embalagens']

@app.get('/api/products')
def products(q:str='',category:str='',province:str='',product_type:str='',seller_role:str=''):
    c=db(); sql='''SELECT p.*,u.full_name seller_name,u.photo seller_photo,u.role seller_role,u.verified seller_verified,u.rating seller_rating,u.reviews seller_reviews FROM products p JOIN users u ON u.id=p.seller_id WHERE p.active=1 AND p.quantity>0'''; args=[]
    if q: sql+=' AND (p.name LIKE ? OR p.category LIKE ?)'; args += [f'%{q}%',f'%{q}%']
    if category: sql+=' AND p.category=?'; args.append(category)
    if province: sql+=' AND p.province=?'; args.append(province)
    if product_type: sql+=' AND p.product_type=?'; args.append(product_type)
    if seller_role: sql+=' AND u.role=?'; args.append(seller_role)
    rows=[dict(r) for r in c.execute(sql+' ORDER BY p.id DESC',args).fetchall()]; c.close(); return rows

@app.post('/api/products')
def create_product(x:ProductIn,u=Depends(require('seller','supplier'))):
    c=db(); cur=c.execute('INSERT INTO products(seller_id,name,category,product_type,price_kz,quantity,unit,weight_kg,province,municipality,farm,description) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(u['id'],x.name,x.category,x.product_type,x.price_kz,x.quantity,x.unit,x.weight_kg,x.province,x.municipality,x.farm,x.description)); pid=cur.lastrowid; audit(c,u['id'],'PRODUCT_CREATED','products',pid); c.commit(); c.close(); return {'id':pid}

@app.post('/api/products/{pid}/photo')
def product_photo(pid:int,file:UploadFile=File(...),u=Depends(auth)):
    c=db(); p=c.execute('SELECT * FROM products WHERE id=?',(pid,)).fetchone()
    if not p or p['seller_id']!=u['id']: c.close(); raise HTTPException(403,'Sem permissão.')
    raw=file.file.read();
    if len(raw)>5*1024*1024 or not file.content_type.startswith('image/'): c.close(); raise HTTPException(400,'Imagem inválida.')
    name=f'{uuid.uuid4().hex}{Path(file.filename or "product.jpg").suffix.lower() or ".jpg"}'; (UPLOADS/name).write_bytes(raw); url='/static/uploads/'+name
    c.execute('UPDATE products SET photo=? WHERE id=?',(url,pid)); audit(c,u['id'],'PRODUCT_PHOTO_UPDATED','products',pid); c.commit(); c.close(); return {'photo':url}

@app.post('/api/orders/quote')
def quote(x:OrderIn,u=Depends(auth)):
    c=db(); p=c.execute('SELECT * FROM products WHERE id=? AND active=1',(x.product_id,)).fetchone(); c.close()
    if not p: raise HTTPException(404,'Produto não encontrado.')
    if x.quantity>p['quantity']: raise HTTPException(400,'Quantidade superior ao estoque.')
    weight=p['weight_kg']*(x.quantity)
    dist=distance_estimate(p['province'],x.destination_province) if x.transport_mode!='pickup' else 0
    transport=calc_transport(weight,dist) if x.transport_mode=='epyalink' else 0
    product_total=round(p['price_kz']*x.quantity,2); service=round(product_total*0.01,2); total=round(product_total+transport+service,2)
    return {'product_total_kz':product_total,'weight_kg':weight,'distance_km':dist,'transport_fee_kz':transport,'service_fee_kz':service,'total_kz':total}

@app.post('/api/orders')
def create_order(x:OrderIn,u=Depends(auth)):
    if u['role'] not in {'buyer','seller','supplier'}: raise HTTPException(403,'Esta conta não pode comprar.')
    c=db(); p=c.execute('SELECT * FROM products WHERE id=? AND active=1',(x.product_id,)).fetchone()
    if not p: c.close(); raise HTTPException(404,'Produto não encontrado.')
    if p['seller_id']==u['id']: c.close(); raise HTTPException(400,'Não pode comprar o próprio produto.')
    if x.quantity>p['quantity']: c.close(); raise HTTPException(400,'Estoque insuficiente.')
    weight=p['weight_kg']*x.quantity; dist=distance_estimate(p['province'],x.destination_province) if x.transport_mode!='pickup' else 0; tf=calc_transport(weight,dist) if x.transport_mode=='epyalink' else 0; pt=round(p['price_kz']*x.quantity,2); sf=round(pt*0.01,2); total=round(pt+tf+sf,2); pin=f'{secrets.randbelow(1000000):06d}'
    cur=c.execute('INSERT INTO orders(buyer_id,seller_id,product_id,quantity,weight_kg,product_total_kz,origin_province,destination_province,destination_municipality,distance_km,transport_fee_kz,service_fee_kz,total_kz,transport_mode,delivery_pin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(u['id'],p['seller_id'],p['id'],x.quantity,weight,pt,p['province'],x.destination_province,x.destination_municipality,dist,tf,sf,total,x.transport_mode,pin)); oid=cur.lastrowid
    c.execute('UPDATE products SET quantity=quantity-? WHERE id=?',(x.quantity,p['id'])); notify(c,p['seller_id'],'Novo pedido',f'Pedido #{oid} recebido.'); audit(c,u['id'],'ORDER_CREATED','orders',oid,{'total_kz':total}); c.commit(); c.close()
    return {'order_id':oid,'product_total_kz':pt,'weight_kg':weight,'distance_km':dist,'transport_fee_kz':tf,'service_fee_kz':sf,'total_kz':total}

@app.get('/api/orders')
def orders(u=Depends(auth)):
    c=db();
    if u['role']=='admin': rows=c.execute('SELECT o.*,p.name product_name,b.full_name buyer_name,s.full_name seller_name FROM orders o JOIN products p ON p.id=o.product_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id ORDER BY o.id DESC').fetchall()
    else: rows=c.execute('SELECT o.*,p.name product_name,b.full_name buyer_name,s.full_name seller_name FROM orders o JOIN products p ON p.id=o.product_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id WHERE o.buyer_id=? OR o.seller_id=? ORDER BY o.id DESC',(u['id'],u['id'])).fetchall()
    out=[]
    for r in rows:
        d=dict(r); d['buyer_photo']=c.execute('SELECT photo FROM users WHERE id=?',(r['buyer_id'],)).fetchone()['photo']; d['seller_photo']=c.execute('SELECT photo FROM users WHERE id=?',(r['seller_id'],)).fetchone()['photo']
        dv=c.execute('SELECT id,transporter_id,status FROM deliveries WHERE order_id=?',(r['id'],)).fetchone()
        d['delivery_id']=dv['id'] if dv else None; d['delivery_transporter_id']=dv['transporter_id'] if dv else None; d['delivery_current_status']=dv['status'] if dv else None
        out.append(d)
    c.close(); return out

@app.post('/api/orders/{oid}/seller-review')
def seller_review(oid:int,x:SellerDecision,u=Depends(require('seller','supplier'))):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
    if not o or o['seller_id']!=u['id']: c.close(); raise HTTPException(403,'Sem permissão.')
    status='SELLER_ACCEPTED' if x.accepted else 'REJECTED'; c.execute('UPDATE orders SET status=? WHERE id=?',(status,oid)); notify(c,o['buyer_id'],'Pedido atualizado',f'O vendedor {"aceitou" if x.accepted else "rejeitou"} o pedido #{oid}.'); audit(c,u['id'],'SELLER_REVIEW','orders',oid,{'accepted':x.accepted}); c.commit(); c.close(); return {'status':status}

@app.post('/api/orders/{oid}/transport-choice')
def transport_choice(oid:int,x:TransportChoice,u=Depends(auth)):
    if x.mode not in {'epyalink','seller','pickup'}: raise HTTPException(400,'Modalidade inválida.')
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=? AND (buyer_id=? OR seller_id=?)',(oid,u['id'],u['id'])).fetchone()
    if not o: c.close(); raise HTTPException(404,'Pedido não encontrado.')
    if x.mode=='pickup':
        c.execute('UPDATE orders SET transport_mode="pickup",transport_fee_kz=0,total_kz=product_total_kz+service_fee_kz,distance_km=0 WHERE id=?',(oid,))
    elif x.mode=='seller':
        c.execute('UPDATE orders SET transport_mode="seller",transport_fee_kz=0,total_kz=product_total_kz+service_fee_kz,distance_km=0 WHERE id=?',(oid,))
    else:
        c.execute('UPDATE orders SET transport_mode="epyalink" WHERE id=?',(oid,))
    audit(c,u['id'],'TRANSPORT_MODE_SELECTED','orders',oid,{'mode':x.mode}); c.commit(); c.close(); return {'ok':True,'mode':x.mode}

@app.get('/api/transporters/available')
def available_transporters(u=Depends(auth)):
    c=db(); rows=[dict(r) for r in c.execute('SELECT t.*,u.full_name,u.photo,u.rating,u.reviews FROM transporters t JOIN users u ON u.id=t.user_id WHERE t.available=1 AND u.status="active"').fetchall()]; c.close(); return rows

@app.post('/api/orders/{oid}/assign-transporter')
def assign_transporter(oid:int,x:AssignTransport,u=Depends(auth)):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=? AND (buyer_id=? OR seller_id=?)',(oid,u['id'],u['id'])).fetchone(); t=c.execute('SELECT * FROM transporters WHERE id=? AND available=1',(x.transporter_id,)).fetchone()
    if not o or not t: c.close(); raise HTTPException(404,'Pedido ou transportador não encontrado.')
    c.execute('INSERT OR REPLACE INTO deliveries(order_id,transporter_id,status) VALUES(?,?,"REQUESTED")',(oid,t['id'])); c.execute('UPDATE orders SET status="TRANSPORT_REQUESTED",delivery_status="REQUESTED" WHERE id=?',(oid,)); notify(c,t['user_id'],'Nova solicitação de transporte',f'Foi atribuído o transporte do pedido #{oid}.'); audit(c,u['id'],'TRANSPORT_ASSIGNED','orders',oid,{'transporter_id':x.transporter_id}); c.commit(); c.close(); return {'ok':True}

@app.post('/api/deliveries/{did}/decision')
def delivery_decision(did:int,x:SellerDecision,u=Depends(require('transporter','transport_company'))):
    c=db(); d=c.execute('SELECT d.*,t.user_id,o.buyer_id,o.seller_id,o.id order_id FROM deliveries d JOIN transporters t ON t.id=d.transporter_id JOIN orders o ON o.id=d.order_id WHERE d.id=?',(did,)).fetchone()
    if not d or d['user_id']!=u['id']: c.close(); raise HTTPException(403,'Solicitação não atribuída a este transportador.')
    status='ACCEPTED' if x.accepted else 'REJECTED'
    c.execute('UPDATE deliveries SET status=? WHERE id=?',(status,did)); c.execute('UPDATE orders SET status=?,delivery_status=? WHERE id=?',('TRANSPORT_ASSIGNED' if x.accepted else 'SELLER_ACCEPTED',status,d['order_id']))
    notify(c,d['buyer_id'],'Transporte atualizado',f'O transporte do pedido #{d["order_id"]} foi {"aceite" if x.accepted else "rejeitado"}.'); audit(c,u['id'],'TRANSPORT_DECISION','deliveries',did,{'accepted':x.accepted}); c.commit(); c.close(); return {'status':status}

@app.post('/api/orders/{oid}/payment')
def payment(oid:int,x:PaymentIn,u=Depends(auth)):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=? AND buyer_id=?',(oid,u['id'])).fetchone()
    if not o: c.close(); raise HTTPException(404,'Pedido não encontrado.')
    if c.execute('SELECT id FROM payments WHERE order_id=?',(oid,)).fetchone(): c.close(); raise HTTPException(409,'Pagamento já registado.')
    commission=round(o['total_kz']*COMMISSION_RATE,2); cur=c.execute('INSERT INTO payments(order_id,method,reference,amount_kz,commission_kz) VALUES(?,?,?,?,?)',(oid,x.method,x.reference,o['total_kz'],commission)); pid=cur.lastrowid; c.execute('UPDATE orders SET payment_status="PENDING" WHERE id=?',(oid,)); notify(c,o['seller_id'],'Pagamento pendente',f'Pagamento do pedido #{oid} aguarda validação.'); audit(c,u['id'],'PAYMENT_SUBMITTED','payments',pid); c.commit(); c.close(); return {'payment_id':pid,'status':'PENDING','amount_kz':o['total_kz']}

@app.get('/api/notifications')
def notifications(u=Depends(auth)):
    c=db(); rows=[dict(r) for r in c.execute('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50',(u['id'],)).fetchall()]; c.close(); return rows

@app.get('/api/orders/{oid}/chat')
def get_chat(oid:int,u=Depends(auth)):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
    if not o or u['id'] not in (o['buyer_id'],o['seller_id']): c.close(); raise HTTPException(403,'Sem acesso.')
    other=o['seller_id'] if u['id']==o['buyer_id'] else o['buyer_id']; user=c.execute('SELECT id,full_name,photo,role,province,verified,rating,reviews FROM users WHERE id=?',(other,)).fetchone(); msgs=[dict(r) for r in c.execute('SELECT * FROM messages WHERE order_id=? ORDER BY id',(oid,)).fetchall()]; c.close(); return {'other_user':dict(user),'messages':msgs}

@app.post('/api/orders/{oid}/chat')
def send_chat(oid:int,x:MessageIn,u=Depends(auth)):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
    if not o or u['id'] not in (o['buyer_id'],o['seller_id']): c.close(); raise HTTPException(403,'Sem acesso.')
    cur=c.execute('INSERT INTO messages(order_id,sender_id,body) VALUES(?,?,?)',(oid,u['id'],x.body.strip())); other=o['seller_id'] if u['id']==o['buyer_id'] else o['buyer_id']; notify(c,other,'Nova mensagem',f'Nova mensagem no pedido #{oid}.'); c.commit(); c.close(); return {'id':cur.lastrowid}

@app.post('/api/orders/{oid}/delivery/start')
def start_delivery(oid:int,u=Depends(require('transporter','transport_company'))):
    c=db(); d=c.execute('SELECT d.*,o.buyer_id FROM deliveries d JOIN orders o ON o.id=d.order_id JOIN transporters t ON t.id=d.transporter_id WHERE d.order_id=? AND t.user_id=?',(oid,u['id'])).fetchone()
    if not d: c.close(); raise HTTPException(403,'Entrega não atribuída.')
    c.execute('UPDATE deliveries SET status="IN_TRANSIT",started_at=CURRENT_TIMESTAMP WHERE order_id=?',(oid,)); c.execute('UPDATE orders SET delivery_status="IN_TRANSIT",status="IN_TRANSIT" WHERE id=?',(oid,)); notify(c,d['buyer_id'],'Transporte iniciado',f'O transporte do pedido #{oid} começou.'); c.commit(); c.close(); return {'ok':True}

class DeliverIn(BaseModel): pin:str
@app.post('/api/orders/{oid}/delivery/confirm')
def confirm_delivery(oid:int,x:DeliverIn,u=Depends(require('transporter','transport_company'))):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone(); d=c.execute('SELECT d.*,t.user_id FROM deliveries d JOIN transporters t ON t.id=d.transporter_id WHERE d.order_id=?',(oid,)).fetchone()
    if not o or not d or d['user_id']!=u['id']: c.close(); raise HTTPException(403,'Sem permissão.')
    if x.pin!=o['delivery_pin']: c.close(); raise HTTPException(400,'PIN inválido.')
    c.execute('UPDATE deliveries SET status="DELIVERED",delivered_at=CURRENT_TIMESTAMP WHERE order_id=?',(oid,)); c.execute('UPDATE orders SET delivery_status="DELIVERED",status="DELIVERED",payment_status="READY_FOR_RELEASE" WHERE id=?',(oid,)); notify(c,o['buyer_id'],'Entrega confirmada',f'Pedido #{oid} entregue.'); notify(c,o['seller_id'],'Entrega confirmada',f'Pedido #{oid} entregue e pronto para liquidação.'); audit(c,u['id'],'DELIVERY_CONFIRMED','orders',oid); c.commit(); c.close(); return {'ok':True}

@app.post('/api/orders/{oid}/rating')
def rate(oid:int,x:RatingIn,u=Depends(auth)):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=? AND status="DELIVERED"',(oid,)).fetchone()
    if not o or u['id'] not in (o['buyer_id'],o['seller_id']): c.close(); raise HTTPException(400,'Avaliação indisponível.')
    target=o['seller_id'] if u['id']==o['buyer_id'] else o['buyer_id']; c.execute('INSERT OR REPLACE INTO ratings(order_id,from_user,to_user,score,comment) VALUES(?,?,?,?,?)',(oid,u['id'],target,x.score,x.comment)); avg=c.execute('SELECT AVG(score),COUNT(*) FROM ratings WHERE to_user=?',(target,)).fetchone(); c.execute('UPDATE users SET rating=?,reviews=? WHERE id=?',(round(avg[0],2),avg[1],target)); c.commit(); c.close(); return {'ok':True}

@app.post('/api/orders/{oid}/dispute')
def dispute(oid:int,x:DisputeIn,u=Depends(auth)):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
    if not o or u['id'] not in (o['buyer_id'],o['seller_id']): c.close(); raise HTTPException(403,'Sem acesso.')
    cur=c.execute('INSERT INTO disputes(order_id,opened_by,reason,evidence) VALUES(?,?,?,?)',(oid,u['id'],x.reason,x.evidence)); notify(c,o['seller_id'] if u['id']==o['buyer_id'] else o['buyer_id'],'Disputa aberta',f'Foi aberta uma disputa no pedido #{oid}.'); audit(c,u['id'],'DISPUTE_OPENED','orders',oid); c.commit(); c.close(); return {'id':cur.lastrowid}

@app.get('/api/market/insights')
def market_insights(u=Depends(auth)):
    c=db(); top=[dict(r) for r in c.execute('SELECT p.name,COUNT(o.id) orders,COALESCE(SUM(o.quantity),0) quantity FROM products p JOIN orders o ON o.product_id=p.id GROUP BY p.id ORDER BY orders DESC LIMIT 10').fetchall()]; regions=[dict(r) for r in c.execute('SELECT destination_province,COUNT(*) orders FROM orders GROUP BY destination_province ORDER BY orders DESC LIMIT 10').fetchall()]; c.close(); return {'top_products':top,'high_demand_regions':regions}

@app.get('/api/admin/dashboard')
def admin_dashboard(u=Depends(require('admin'))):
    c=db(); out={};
    for k,sql in {'users':'SELECT COUNT(*) n FROM users','products':'SELECT COUNT(*) n FROM products','orders':'SELECT COUNT(*) n FROM orders','payments_pending':'SELECT COUNT(*) n FROM payments WHERE status="PENDING"','disputes':'SELECT COUNT(*) n FROM disputes WHERE status="OPEN"','transporters':'SELECT COUNT(*) n FROM transporters'}.items(): out[k]=c.execute(sql).fetchone()['n']
    out['sales_kz']=c.execute('SELECT COALESCE(SUM(product_total_kz),0) n FROM orders WHERE status="DELIVERED"').fetchone()['n']; out['transport_kz']=c.execute('SELECT COALESCE(SUM(transport_fee_kz),0) n FROM orders WHERE status="DELIVERED"').fetchone()['n']; out['commissions_kz']=c.execute('SELECT COALESCE(SUM(commission_kz),0) n FROM payments WHERE status="PAID"').fetchone()['n']; c.close(); return out

@app.get('/api/admin/users')
def admin_users(u=Depends(require('admin'))):
    c=db(); r=[dict(x) for x in c.execute('SELECT id,full_name,phone,role,province,municipality,company_name,farm_name,photo,verified,status,rating,reviews,completed_sales,completed_deliveries,created_at FROM users ORDER BY id DESC').fetchall()]; c.close(); return r

@app.post('/api/admin/users/{uid}/verify')
def verify_user(uid:int,u=Depends(require('admin'))):
    c=db(); c.execute('UPDATE users SET verified=1 WHERE id=?',(uid,)); audit(c,u['id'],'USER_VERIFIED','users',uid); c.commit(); c.close(); return {'ok':True}

@app.get('/api/admin/products')
def admin_products(u=Depends(require('admin'))):
    c=db(); r=[dict(x) for x in c.execute('SELECT p.*,u.full_name seller_name,u.photo seller_photo FROM products p JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC').fetchall()]; c.close(); return r

@app.get('/api/admin/orders')
def admin_orders(u=Depends(require('admin'))):
    c=db(); r=[dict(x) for x in c.execute('SELECT o.*,p.name product_name,b.full_name buyer_name,s.full_name seller_name FROM orders o JOIN products p ON p.id=o.product_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id ORDER BY o.id DESC').fetchall()]; c.close(); return r

@app.get('/api/admin/payments')
def admin_payments(u=Depends(require('admin'))):
    c=db(); r=[dict(x) for x in c.execute('SELECT p.*,o.product_total_kz,o.transport_fee_kz,o.total_kz,b.full_name buyer_name,s.full_name seller_name FROM payments p JOIN orders o ON o.id=p.order_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id ORDER BY p.id DESC').fetchall()]; c.close(); return r

class PaymentApproval(BaseModel): approved:bool
@app.post('/api/admin/payments/{pid}/approve')
def approve_payment(pid:int,x:PaymentApproval,u=Depends(require('admin'))):
    c=db(); p=c.execute('SELECT * FROM payments WHERE id=?',(pid,)).fetchone();
    if not p: c.close(); raise HTTPException(404,'Pagamento não encontrado.')
    status='PAID' if x.approved else 'REJECTED'; c.execute('UPDATE payments SET status=? WHERE id=?',(status,pid)); o=c.execute('SELECT * FROM orders WHERE id=?',(p['order_id'],)).fetchone(); c.execute('UPDATE orders SET payment_status=? WHERE id=?',('PAID' if x.approved else 'REJECTED',o['id'])); notify(c,o['buyer_id'],'Pagamento atualizado',f'O pagamento do pedido #{o["id"]} foi {"validado" if x.approved else "recusado"}.'); audit(c,u['id'],'PAYMENT_REVIEW','payments',pid,{'approved':x.approved}); c.commit(); c.close(); return {'status':status}

@app.post('/api/admin/orders/{oid}/release')
def admin_release(oid:int,u=Depends(require('admin'))):
    c=db(); o=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
    if not o: c.close(); raise HTTPException(404,'Pedido não encontrado.')
    if o['delivery_status']!='DELIVERED' or o['payment_status'] not in ('PAID','READY_FOR_RELEASE'): c.close(); raise HTTPException(400,'Pagamento e entrega ainda não cumprem as condições de liquidação.')
    commission=round(o['total_kz']*COMMISSION_RATE,2); c.execute('UPDATE orders SET payment_status="RELEASED" WHERE id=?',(oid,)); notify(c,o['seller_id'],'Pagamento liberado',f'A liquidação do pedido #{oid} foi autorizada.'); audit(c,u['id'],'SETTLEMENT_RELEASED','orders',oid,{'commission_kz':commission}); c.commit(); c.close(); return {'ok':True,'commission_kz':commission}

@app.get('/api/admin/reports')
def reports(u=Depends(require('admin'))):
    c=db(); r={}; r['sales_total_kz']=c.execute('SELECT COALESCE(SUM(product_total_kz),0) n FROM orders WHERE status="DELIVERED"').fetchone()['n']; r['transport_total_kz']=c.execute('SELECT COALESCE(SUM(transport_fee_kz),0) n FROM orders WHERE status="DELIVERED"').fetchone()['n']; r['orders_total']=c.execute('SELECT COUNT(*) n FROM orders').fetchone()['n']; r['delivered_orders']=c.execute('SELECT COUNT(*) n FROM orders WHERE status="DELIVERED"').fetchone()['n']; r['active_users']=c.execute('SELECT COUNT(*) n FROM users WHERE status="active"').fetchone()['n']; r['products_active']=c.execute('SELECT COUNT(*) n FROM products WHERE active=1').fetchone()['n']; r['pending_payments_kz']=c.execute('SELECT COALESCE(SUM(amount_kz),0) n FROM payments WHERE status="PENDING"').fetchone()['n']; r['users_by_role']=[dict(x) for x in c.execute('SELECT role,COUNT(*) count FROM users GROUP BY role').fetchall()]; r['orders_by_status']=[dict(x) for x in c.execute('SELECT status,COUNT(*) count FROM orders GROUP BY status').fetchall()]; c.close(); return r

@app.get('/api/admin/audit')
def admin_audit(u=Depends(require('admin'))):
    c=db(); r=[dict(x) for x in c.execute('SELECT a.*,u.full_name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300').fetchall()]; c.close(); return {'items':r,'total':len(r)}

@app.get('/api/admin/disputes')
def admin_disputes(u=Depends(require('admin'))):
    c=db(); r=[dict(x) for x in c.execute('SELECT d.*,u.full_name opened_by_name FROM disputes d JOIN users u ON u.id=d.opened_by ORDER BY d.id DESC').fetchall()]; c.close(); return r

@app.post('/api/admin/settings/{key}')
def setting(key:str,x:SettingIn,u=Depends(require('admin'))):
    if key not in {'transport_rate_km','transport_rate_kg','transport_base','commission_rate'}: raise HTTPException(400,'Configuração inválida.')
    float(x.value); c=db(); c.execute('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',(key,x.value)); audit(c,u['id'],'SETTING_CHANGED','settings',None,{key:x.value}); c.commit(); c.close(); return {'ok':True}

@app.post('/api/transporters/register')
def register_transporter(vehicle_type:str='camião',plate:str='',capacity_kg:float=0,u=Depends(require('transporter','transport_company'))):
    if not plate: raise HTTPException(400,'Matrícula obrigatória.')
    c=db(); cur=c.execute('INSERT INTO transporters(user_id,vehicle_type,plate,capacity_kg) VALUES(?,?,?,?)',(u['id'],vehicle_type,plate,capacity_kg)); c.commit(); c.close(); return {'id':cur.lastrowid}

@app.post('/api/favorites/{kind}/{target_id}')
def favorite(kind:str,target_id:int,u=Depends(auth)):
    c=db(); c.execute('INSERT OR IGNORE INTO favorites(user_id,kind,target_id) VALUES(?,?,?)',(u['id'],kind,target_id)); c.commit(); c.close(); return {'ok':True}

@app.get('/api/favorites')
def favorites(u=Depends(auth)):
    c=db(); r=[dict(x) for x in c.execute('SELECT * FROM favorites WHERE user_id=? ORDER BY id DESC',(u['id'],)).fetchall()]; c.close(); return r

# Static files after API routes.
from fastapi.staticfiles import StaticFiles
app.mount('/static', StaticFiles(directory=BASE/'static'), name='static')

if __name__=='__main__':
    import uvicorn; uvicorn.run('app:app',host='0.0.0.0',port=int(os.getenv('PORT','8000')))
