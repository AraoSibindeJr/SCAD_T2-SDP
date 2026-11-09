CREATE TABLE IF NOT EXISTS stock_positions (
  product_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  region TEXT NOT NULL,
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
  minimum_stock INTEGER NOT NULL CHECK (minimum_stock >= 0),
  target_stock INTEGER NOT NULL CHECK (target_stock > minimum_stock),
  incoming_qty INTEGER NOT NULL DEFAULT 0 CHECK (incoming_qty >= 0),
  reorder_cycle INTEGER NOT NULL DEFAULT 1 CHECK (reorder_cycle > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (region IN ('south','center','north'))
);

-- O catálogo de ordens reside no fragmento north (também é criado nos outros
-- fragmentos para simplificar o bootstrap; a API só escreve em north).
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  items JSONB NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  origin_region TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_SUPPLIER',
  external_order_id TEXT,
  invoice_path TEXT,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_dispatch ON purchase_orders(status, next_retry_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registo local de recepção: cada produto de uma ordem pode ser recebido apenas uma vez por região.
CREATE TABLE IF NOT EXISTS stock_receipts (
  order_id UUID NOT NULL,
  product_id TEXT NOT NULL,
  region TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  received_by TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, product_id)
);
