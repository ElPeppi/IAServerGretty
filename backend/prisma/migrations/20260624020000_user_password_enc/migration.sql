-- Copia cifrada reversible de la contraseña (AES) para que el admin pueda verla.
-- El login sigue usando el hash bcrypt de la columna "password".
ALTER TABLE "users" ADD COLUMN "passwordEnc" TEXT;
