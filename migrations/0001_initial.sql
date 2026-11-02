CREATE TABLE IF NOT EXISTS passes (
  pass_type_identifier TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  authentication_token TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (pass_type_identifier, serial_number)
);

CREATE TABLE IF NOT EXISTS devices (
  device_library_identifier TEXT PRIMARY KEY,
  push_token TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS registrations (
  device_library_identifier TEXT NOT NULL,
  pass_type_identifier TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  PRIMARY KEY (device_library_identifier, pass_type_identifier, serial_number),
  FOREIGN KEY (device_library_identifier) REFERENCES devices(device_library_identifier),
  FOREIGN KEY (pass_type_identifier, serial_number)
    REFERENCES passes(pass_type_identifier, serial_number)
);

CREATE INDEX IF NOT EXISTS idx_registrations_pass
  ON registrations(pass_type_identifier, serial_number);
