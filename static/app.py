from pathlib import Path
import sqlite3,hashlib,secrets,os
from datetime import datetime,timezone
from fastapi import FastAPI,HTTPException,Header
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
BASE=Path(__file__).parent;DB=Path(os.getenv("EPYALINK_DB",BASE/"database/epyalink.db"))
app=FastAPI(title="EPYALINK",version="1.0.0");app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_methods=["*"],allow_headers=["*"]);app.mount("/static",StaticFiles(directory=BASE/"static"),name="static")
def now(): return datetime.now(timezone.utc).isoformat()
def db(): c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;return c
def ph(p): s=secrets.token_hex(16);return s+"$"+hashlib.pbkdf2_hmac("sha256",p.encode(),s.encode(),120000).hex()
def pv(p,x):
 try:s,h=x.split("$");return secrets.compare_digest(hashlib.pbkdf2_hmac("sha256",p.encode(),s.encode(),120000).hex(),h)
 except:return False
def init():
 DB.parent.mkdir(exist_ok=True);c=db();c.executescript('''
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,email TEXT,password TEXT,role TEXT,photo TEXT DEFAULT '/static/images/profile.svg',province TEXT,municipality TEXT,verified INTEGER DEFAULT 0,rating REAL DEFAULT 0,reviews INTEGER DEFAULT 0,sales INTEGER DEFAULT 0,created TEXT);
CREATE TABLE IF NOT EXISTS farms(id INTEGER PRIMARY KEY,owner INTEGER,name TEXT,province TEXT,municipality TEXT,description TEXT,verified INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,seller INTEGER,farm INTEGER,name TEXT,category TEXT,description TEXT,price REAL,unit TEXT,stock REAL,province TEXT,municipality TEXT,photo TEXT,active INTEGER DEFAULT 1,created TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,buyer INTEGER,seller INTEGER,product INTEGER,quantity REAL,price REAL,total REAL,origin TEXT,destination TEXT,transport TEXT,status TEXT DEFAULT 'pending',payment TEXT DEFAULT 'pending',pin TEXT,delivered INTEGER DEFAULT 0,created TEXT,updated TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,order_id INTEGER,sender INTEGER,receiver INTEGER,message TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,user_id INTEGER,title TEXT,message TEXT,read INTEGER DEFAULT 0,created TEXT);
CREATE TABLE IF NOT EXISTS disputes(id INTEGER PRIMARY KEY,order_id INTEGER,opened_by INTEGER,reason TEXT,description TEXT,status TEXT DEFAULT 'open',created TEXT);
CREATE TABLE IF NOT EXISTS transporters(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE,company TEXT,vehicle TEXT,plate TEXT,location TEXT,available INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,created TEXT);
''')
 if c.execute("SELECT COUNT(*) FROM users").fetchone()[0]==0:
  for n,p,e,r in [("Administrador","900000001","admin@epyalink.ao","admin"),("Cooperativa Huambo","900000002","produtor@epyalink.ao","seller"),("Comprador B2B","900000003","comprador@epyalink.ao","buyer"),("EPYALINK Transportes","900000004","transporte@epyalink.ao","transporter")]:
   c.execute("INSERT INTO users(name,phone,email,password,role,province,municipality,verified,rating,reviews,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(n,p,e,ph("Epyalink@2026"),r,"Huambo","Huambo",1,4.8 if r=="seller" else 0,37 if r=="seller" else 0,now()))
  sid=c.execute("SELECT id FROM users WHERE role='seller'").fetchone()[0];farm=c.execute("INSERT INTO farms(owner,name,province,municipality,description,verified) VALUES(?,?,?,?,?,1)",(sid,"Fazenda Modelo Huambo","Huambo","Huambo","Produção para fornecimento interprovincial")).lastrowid
  for n,cat,pr,st,mun in [("Milho","Cereais",320,5000,"Huambo"),("Feijão","Leguminosas",850,2500,"Caála"),("Batata","Tubérculos",480,3000,"Huambo")]:c.execute("INSERT INTO products(seller,farm,name,category,description,price,unit,stock,province,municipality,photo,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(sid,farm,n,cat,"Produto agrícola disponível para fornecimento B2B.",pr,"kg",st,"Huambo",mun,"/static/images/product.svg",now()))
  tid=c.execute("SELECT id FROM users WHERE role='transporter'").fetchone()[0];c.execute("INSERT INTO transporters(user_id,company,vehicle,plate,location) VALUES(?,?,?,?,?)",(tid,"EPYALINK Transportes","Camião 10T","LD-12-34-AA","Huambo, Angola"));c.commit()
 c.close()
class Register(BaseModel):name:str;phone:str;email:str|None=None;password:str;role:str;province:str="Huambo";municipality:str|None=None
class Login(BaseModel):phone:str;password:str
class Product(BaseModel):name:str;category:str;description:str="";price:float;unit:str;stock:float;province:str;municipality:str|None=None
class Order(BaseModel):product_id:int;quantity:float;destination:str;transport:str="epyalink"
class Message(BaseModel):receiver_id:int;message:str;order_id:int|None=None
def user(a):
 if not a:return None
 c=db();r=c.execute("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=?",(a.replace("Bearer ",""),)).fetchone();c.close();return dict(r) if r else None
@app.get("/")
def home():return FileResponse(BASE/"index.html")
@app.get("/health")
def health():return {"status":"ok","service":"EPYALINK"}
@app.post("/api/auth/register")
def reg(x:Register):
 if x.role not in ["buyer","seller","transporter"]:raise HTTPException(400,"Perfil inválido")
 c=db()
 try:i=c.execute("INSERT INTO users(name,phone,email,password,role,province,municipality,created) VALUES(?,?,?,?,?,?,?,?)",(x.name,x.phone,x.email,ph(x.password),x.role,x.province,x.municipality,now())).lastrowid;c.commit();return {"user_id":i}
 except sqlite3.IntegrityError:raise HTTPException(409,"Telefone já registado")
 finally:c.close()
@app.post("/api/auth/login")
def login(x:Login):
 c=db();r=c.execute("SELECT * FROM users WHERE phone=?",(x.phone,)).fetchone()
 if not r or not pv(x.password,r["password"]):c.close();raise HTTPException(401,"Credenciais inválidas")
 t=secrets.token_hex(32);c.execute("INSERT INTO sessions VALUES(?,?,?)",(t,r["id"],now()));c.commit();u=dict(r);u.pop("password");c.close();return {"token":t,"user":u}
@app.get("/api/me")
def me(authorization:str|None=Header(None)):
 u=user(authorization)
 if not u:raise HTTPException(401,"Sessão inválida")
 u.pop("password",None);return u
@app.get("/api/products")
def products(q:str="",category:str="",province:str=""):
 c=db();sql="SELECT p.*,u.name seller_name,u.verified seller_verified,u.rating seller_rating,u.reviews seller_reviews FROM products p JOIN users u ON u.id=p.seller WHERE p.active=1 AND p.stock>0";a=[]
 if q:sql+=" AND (p.name LIKE ? OR p.category LIKE ?)";a += [f"%{q}%",f"%{q}%"]
 if category:sql+=" AND p.category=?";a.append(category)
 if province:sql+=" AND p.province=?";a.append(province)
 r=[dict(x) for x in c.execute(sql+" ORDER BY p.id DESC",a)];c.close();return r
@app.post("/api/products")
def newproduct(x:Product,authorization:str|None=Header(None)):
 u=user(authorization)
 if not u or u["role"] not in ["seller","admin"]:raise HTTPException(403,"Acesso reservado ao vendedor")
 c=db();i=c.execute("INSERT INTO products(seller,name,category,description,price,unit,stock,province,municipality,photo,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(u["id"],x.name,x.category,x.description,x.price,x.unit,x.stock,x.province,x.municipality,"/static/images/product.svg",now())).lastrowid;c.commit();c.close();return {"product_id":i}
@app.post("/api/orders")
def neworder(x:Order,authorization:str|None=Header(None)):
 u=user(authorization)
 if not u or u["role"]!="buyer":raise HTTPException(403,"Apenas compradores")
 c=db();p=c.execute("SELECT * FROM products WHERE id=? AND active=1",(x.product_id,)).fetchone()
 if not p or p["stock"]<x.quantity:c.close();raise HTTPException(400,"Produto ou stock indisponível")
 total=round(p["price"]*x.quantity,2);pin=f"{secrets.randbelow(1000000):06d}";i=c.execute("INSERT INTO orders(buyer,seller,product,quantity,price,total,origin,destination,transport,pin,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(u["id"],p["seller"],p["id"],x.quantity,p["price"],total,p["province"],x.destination,x.transport,pin,now(),now())).lastrowid;c.execute("UPDATE products SET stock=stock-? WHERE id=?",(x.quantity,x.product_id));c.execute("INSERT INTO notifications(user_id,title,message,created) VALUES(?,?,?,?)",(p["seller"],"Novo pedido",f"Pedido #{i}",now()));c.commit();c.close();return {"order_id":i,"total":total}
@app.get("/api/orders")
def orders(authorization:str|None=Header(None)):
 u=user(authorization)
 if not u:raise HTTPException(401,"Sessão inválida")
 c=db();r=[dict(x) for x in c.execute("SELECT o.*,p.name product_name FROM orders o JOIN products p ON p.id=o.product WHERE o.buyer=? OR o.seller=? ORDER BY o.id DESC",(u["id"],u["id"]))];c.close();return r
@app.post("/api/orders/{i}/pay")
def pay(i:int,authorization:str|None=Header(None)):
 u=user(authorization);c=db();o=c.execute("SELECT * FROM orders WHERE id=? AND buyer=?",(i,u["id"] if u else 0)).fetchone()
 if not o:c.close();raise HTTPException(404,"Pedido não encontrado")
 c.execute("UPDATE orders SET payment='confirmed',status='accepted',updated=? WHERE id=?",(now(),i));c.commit();c.close();return {"status":"confirmed"}
@app.post("/api/orders/{i}/confirm")
def confirm(i:int,pin:str,authorization:str|None=Header(None)):
 u=user(authorization);c=db();o=c.execute("SELECT * FROM orders WHERE id=? AND buyer=?",(i,u["id"] if u else 0)).fetchone()
 if not o or o["pin"]!=pin:c.close();raise HTTPException(400,"PIN inválido")
 c.execute("UPDATE orders SET status='delivered',delivered=1,updated=? WHERE id=?",(now(),i));c.commit();c.close();return {"message":"Entrega confirmada"}
@app.get("/api/chat/{other}")
def getchat(other:int,order_id:int|None=None,authorization:str|None=Header(None)):
 u=user(authorization)
 if not u:raise HTTPException(401,"Sessão inválida")
 c=db();p=c.execute("SELECT id,name,role,photo,verified,rating FROM users WHERE id=?",(other,)).fetchone();sql="SELECT m.*,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender WHERE ((m.sender=? AND m.receiver=?) OR (m.sender=? AND m.receiver=?))";a=[u["id"],other,other,u["id"]]
 if order_id:sql+=" AND m.order_id=?";a.append(order_id)
 r=[dict(x) for x in c.execute(sql+" ORDER BY m.id",a)];c.close();return {"profile":dict(p),"messages":r}
@app.post("/api/chat")
def send(x:Message,authorization:str|None=Header(None)):
 u=user(authorization)
 if not u:raise HTTPException(401,"Sessão inválida")
 c=db();i=c.execute("INSERT INTO messages(order_id,sender,receiver,message,created) VALUES(?,?,?,?,?)",(x.order_id,u["id"],x.receiver_id,x.message,now())).lastrowid;c.commit();c.close();return {"message_id":i}
@app.get("/api/notifications")
def notifications(authorization:str|None=Header(None)):
 u=user(authorization)
 if not u:raise HTTPException(401,"Sessão inválida")
 c=db();r=[dict(x) for x in c.execute("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC",(u["id"],))];c.close();return r
@app.get("/api/admin")
def admin(authorization:str|None=Header(None)):
 u=user(authorization)
 if not u or u["role"]!="admin":raise HTTPException(403,"Administrador necessário")
 c=db();r={"utilizadores":c.execute("SELECT COUNT(*) FROM users").fetchone()[0],"produtos":c.execute("SELECT COUNT(*) FROM products").fetchone()[0],"pedidos":c.execute("SELECT COUNT(*) FROM orders").fetchone()[0],"entregas":c.execute("SELECT COUNT(*) FROM orders WHERE status='delivered'").fetchone()[0]};c.close();return r
init()
