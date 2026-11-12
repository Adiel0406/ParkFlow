CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE parking_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parking_lot_id UUID NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'employee')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_parking_lot_id_id_key UNIQUE (parking_lot_id, id)
);

CREATE UNIQUE INDEX accounts_parking_email_unique
  ON accounts (parking_lot_id, lower(email));
CREATE UNIQUE INDEX one_admin_per_parking_lot
  ON accounts (parking_lot_id)
  WHERE role = 'admin';

CREATE TABLE parking_settings (
  parking_lot_id UUID PRIMARY KEY REFERENCES parking_lots(id) ON DELETE CASCADE,
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  billing_intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parking_lot_id UUID NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  make TEXT NOT NULL,
  color TEXT NOT NULL,
  floor_id TEXT,
  slot INTEGER,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  paid_amount NUMERIC(10, 2),
  exited_at TIMESTAMPTZ,
  CONSTRAINT vehicles_parking_lot_id_id_key UNIQUE (parking_lot_id, id)
);

CREATE UNIQUE INDEX active_vehicle_plate_unique
  ON vehicles (parking_lot_id, upper(plate))
  WHERE exited_at IS NULL;

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parking_lot_id UUID NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL,
  recipient_email TEXT,
  customer_name TEXT,
  customer_tax_id TEXT,
  total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  details JSONB NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_sent_at TIMESTAMPTZ,
  CONSTRAINT invoices_vehicle_same_parking_fk FOREIGN KEY (parking_lot_id, vehicle_id)
    REFERENCES vehicles (parking_lot_id, id)
);

CREATE TABLE parking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parking_lot_id UUID NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
  account_id UUID,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT parking_events_account_same_parking_fk FOREIGN KEY (parking_lot_id, account_id)
    REFERENCES accounts (parking_lot_id, id) ON DELETE SET NULL (account_id)
);

CREATE INDEX vehicles_lot_active_idx ON vehicles (parking_lot_id, entered_at DESC)
  WHERE exited_at IS NULL;
CREATE INDEX invoices_lot_paid_idx ON invoices (parking_lot_id, paid_at DESC);
CREATE INDEX parking_events_lot_created_idx ON parking_events (parking_lot_id, created_at DESC);