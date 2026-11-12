BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_parking_lot_id_id_key'
      AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_parking_lot_id_id_key UNIQUE (parking_lot_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vehicles_parking_lot_id_id_key'
      AND conrelid = 'vehicles'::regclass
  ) THEN
    ALTER TABLE vehicles
      ADD CONSTRAINT vehicles_parking_lot_id_id_key UNIQUE (parking_lot_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_vehicle_same_parking_fk'
      AND conrelid = 'invoices'::regclass
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_vehicle_same_parking_fk
      FOREIGN KEY (parking_lot_id, vehicle_id)
      REFERENCES vehicles (parking_lot_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'parking_events_account_same_parking_fk'
      AND conrelid = 'parking_events'::regclass
  ) THEN
    ALTER TABLE parking_events
      ADD CONSTRAINT parking_events_account_same_parking_fk
      FOREIGN KEY (parking_lot_id, account_id)
      REFERENCES accounts (parking_lot_id, id) ON DELETE SET NULL (account_id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS one_admin_per_parking_lot
  ON accounts (parking_lot_id)
  WHERE role = 'admin';

COMMIT;