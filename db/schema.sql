-- EPYALINK — schema PostgreSQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('BUYER','SELLER','CARRIER','ADMIN')),
  buyer_rating_sum INTEGER NOT NULL DEFAULT 0,
  buyer_rating_cnt INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('SMS','WHATSAPP')),
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON password_reset_otps(user_id);

CREATE TABLE IF NOT EXISTS farms (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id       TEXT UNIQUE NOT NULL REFERENCES users(id),
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('PRODUTOR','EMPRESA','COMERCIANTE')),
  province       TEXT NOT NULL,
  municipality   TEXT NOT NULL,
  about          TEXT NOT NULL DEFAULT '',
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_url     TEXT,
  rating_sum     INTEGER NOT NULL DEFAULT 0,
  rating_count   INTEGER NOT NULL DEFAULT 0,
  sales_count    INTEGER NOT NULL DEFAULT 0,
  completed_rate INTEGER NOT NULL DEFAULT 0,
  crops          TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS farm_photos (
  id      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  url     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  farm_id    TEXT NOT NULL REFERENCES farms(id),
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  unit       TEXT NOT NULL CHECK (unit IN ('kg','toneladas','sacos','unidades')),
  price      INTEGER NOT NULL,
  qty        DOUBLE PRECISION NOT NULL,
  qty0       DOUBLE PRECISION NOT NULL,
  photo_url  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_farm ON products(farm_id);

CREATE TABLE IF NOT EXISTS carrier_profiles (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT UNIQUE NOT NULL REFERENCES users(id),
  company_name  TEXT NOT NULL,
  province      TEXT NOT NULL,
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  rating_count  INTEGER NOT NULL DEFAULT 0,
  trips_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  carrier_id     TEXT NOT NULL REFERENCES carrier_profiles(id),
  plate          TEXT NOT NULL,
  type           TEXT NOT NULL,
  capacity_tons  DOUBLE PRECISION NOT NULL,
  status         TEXT NOT NULL DEFAULT 'disponivel'
);

CREATE TABLE IF NOT EXISTS drivers (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  carrier_id TEXT NOT NULL REFERENCES carrier_profiles(id),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'disponivel'
);

CREATE TABLE IF NOT EXISTS carrier_documents (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  carrier_id TEXT NOT NULL REFERENCES carrier_profiles(id),
  name       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code           TEXT NOT NULL,
  buyer_id       TEXT NOT NULL REFERENCES users(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  qty            DOUBLE PRECISION NOT NULL,
  unit_price     INTEGER NOT NULL,
  goods_total    INTEGER NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('RECOLHA','VENDEDOR','AGROLINK')),
  dest_province  TEXT NOT NULL,
  distance_km    INTEGER NOT NULL,
  fee_total      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  pay_method     TEXT,
  carrier_id     TEXT REFERENCES carrier_profiles(id),
  driver_name    TEXT,
  vehicle_plate  TEXT,
  near           BOOLEAN NOT NULL DEFAULT FALSE,
  prev_status    TEXT,
  evidence_photo TEXT,
  evidence_place TEXT,
  evidence_who   TEXT,
  evidence_at    TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  rated_buyer    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_carrier ON orders(carrier_id);

CREATE TABLE IF NOT EXISTS order_logs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_order ON order_logs(order_id);

CREATE TABLE IF NOT EXISTS message_threads (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id TEXT NOT NULL REFERENCES products(id),
  order_id   TEXT REFERENCES orders(id),
  buyer_id   TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_threads_buyer ON message_threads(buyer_id);
CREATE INDEX IF NOT EXISTS idx_threads_product ON message_threads(product_id);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  thread_id      TEXT NOT NULL REFERENCES message_threads(id),
  sender_id      TEXT NOT NULL REFERENCES users(id),
  sender_role    TEXT NOT NULL,
  text           TEXT NOT NULL,
  read_by_buyer  BOOLEAN NOT NULL DEFAULT FALSE,
  read_by_seller BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  target_type TEXT NOT NULL CHECK (target_type IN ('FARM','CARRIER','USER')),
  target_id   TEXT NOT NULL,
  from_user_id TEXT NOT NULL REFERENCES users(id),
  from_name   TEXT NOT NULL,
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text        TEXT NOT NULL DEFAULT '',
  order_id    TEXT REFERENCES orders(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_target ON reviews(target_type, target_id);

CREATE TABLE IF NOT EXISTS disputes (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  type       TEXT NOT NULL,
  text       TEXT NOT NULL,
  photo_url  TEXT,
  state      TEXT NOT NULL DEFAULT 'ABERTA',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ok',
  view       TEXT,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS favorites (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL CHECK (type IN ('PRODUCT','FARM')),
  target_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, target_id)
);

-- Regista pesquisas/filtros por categoria, usados para alimentar a "Inteligência de mercado"
-- com dados reais de utilização (em vez de números inventados).
CREATE TABLE IF NOT EXISTS search_events (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  category   TEXT NOT NULL,
  province   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_cat ON search_events(category, created_at);

CREATE TABLE IF NOT EXISTS verification_requests (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  farm_id    TEXT REFERENCES farms(id),
  carrier_id TEXT REFERENCES carrier_profiles(id),
  docs       TEXT[] NOT NULL DEFAULT '{}',
  state      TEXT NOT NULL DEFAULT 'PENDENTE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- EPYALINK — extensões B2B interprovincial, GPS, PIN SMS, custódia e retalho urbano
-- (idempotente: seguro de correr em cada arranque, em bases novas ou já existentes)
-- =====================================================================

-- novo papel: Ponto EPYALINK rural (agente comunitário)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_role_check' AND pg_get_constraintdef(oid) LIKE '%AGENT%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('BUYER','SELLER','CARRIER','AGENT','ADMIN'));
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nif TEXT;

-- transportadora interprovincial ou estafeta urbano (moto/carrinha de bairro)
ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'INTERPROVINCIAL';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='carrier_kind_check') THEN
    ALTER TABLE carrier_profiles ADD CONSTRAINT carrier_kind_check CHECK (kind IN ('INTERPROVINCIAL','ESTAFETA'));
  END IF;
END $$;

-- Pontos EPYALINK rurais
CREATE TABLE IF NOT EXISTS agent_profiles (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT UNIQUE NOT NULL REFERENCES users(id),
  point_name        TEXT NOT NULL,
  province          TEXT NOT NULL,
  municipality      TEXT NOT NULL,
  verified          BOOLEAN NOT NULL DEFAULT FALSE,
  validations_count INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hubs intermédios regionais e micro-hubs urbanos
CREATE TABLE IF NOT EXISTS hubs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name       TEXT UNIQUE NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('REGIONAL','MICRO_URBANO')),
  province   TEXT NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Hubs iniciais (marcadores de posição no centro de cada província; o administrador
-- pode acrescentar os hubs reais, com coordenadas exatas, em Rede logística).
INSERT INTO hubs (name, kind, province, lat, lng) VALUES
  ('Hub Regional Luanda','REGIONAL','Luanda',-8.84,13.23),
  ('Hub Regional Huambo','REGIONAL','Huambo',-12.78,15.74),
  ('Hub Regional Malanje','REGIONAL','Malanje',-9.54,16.34),
  ('Hub Regional Bié','REGIONAL','Bié',-12.38,16.93),
  ('Hub Regional Cuanza Sul','REGIONAL','Cuanza Sul',-11.20,13.84),
  ('Hub Regional Benguela','REGIONAL','Benguela',-12.58,13.41),
  ('Micro-Hub Urbano Luanda','MICRO_URBANO','Luanda',-8.84,13.23),
  ('Micro-Hub Urbano Huambo','MICRO_URBANO','Huambo',-12.78,15.74),
  ('Micro-Hub Urbano Malanje','MICRO_URBANO','Malanje',-9.54,16.34),
  ('Micro-Hub Urbano Bié','MICRO_URBANO','Bié',-12.38,16.93),
  ('Micro-Hub Urbano Cuanza Sul','MICRO_URBANO','Cuanza Sul',-11.20,13.84),
  ('Micro-Hub Urbano Benguela','MICRO_URBANO','Benguela',-12.58,13.41)
ON CONFLICT (name) DO NOTHING;

-- produtos: lote mínimo B2B e venda fracionada opcional a retalho
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS retail_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS retail_price_kg INTEGER;

-- pedidos: segmento, novo modo ESTAFETA, custódia, rastreio e PIN
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_mode_check' AND pg_get_constraintdef(oid) LIKE '%ESTAFETA%') THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_mode_check;
    ALTER TABLE orders ADD CONSTRAINT orders_mode_check CHECK (mode IN ('RECOLHA','VENDEDOR','AGROLINK','ESTAFETA'));
  END IF;
END $$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS segment TEXT NOT NULL DEFAULT 'B2B';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS retail_kg DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_zone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS origin_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS origin_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS point_id TEXT REFERENCES agent_profiles(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_validated_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pin_sent_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pin_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_point ON orders(point_id);

-- Rastreamento GPS de ponta a ponta
CREATE TABLE IF NOT EXISTS tracking_points (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy    DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tracking_order ON tracking_points(order_id, recorded_at);

-- Pontos de passagem do percurso: recolha no Ponto, Hubs intermédios, chegada
CREATE TABLE IF NOT EXISTS order_checkpoints (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  kind       TEXT NOT NULL CHECK (kind IN ('PICKUP','HUB','ARRIVAL')),
  hub_id     TEXT REFERENCES hubs(id),
  name       TEXT NOT NULL,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_order ON order_checkpoints(order_id);

-- Livro-razão (custódia libertada, comissões, taxas) e carteira móvel
CREATE TABLE IF NOT EXISTS ledger_entries (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id   TEXT REFERENCES orders(id),
  user_id    TEXT REFERENCES users(id),
  party      TEXT NOT NULL CHECK (party IN ('SELLER','CARRIER','AGENT','PLATFORM')),
  kind       TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger_entries(order_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,
  fee        INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDENTE_CODIGO' CHECK (status IN ('PENDENTE_CODIGO','PENDENTE_PAGAMENTO','PAGO','CANCELADO')),
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);

-- Verificação também para Pontos EPYALINK
ALTER TABLE verification_requests ADD COLUMN IF NOT EXISTS agent_id TEXT REFERENCES agent_profiles(id);
