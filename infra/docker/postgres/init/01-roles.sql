-- এই স্ক্রিপ্ট শুধু একবার চলে: Postgres ভলিউম প্রথমবার তৈরি হওয়ার সময়।
-- ভলিউম মুছে (docker compose down -v) আবার তুললে আবার চলবে।

CREATE ROLE omnivo_migrator WITH LOGIN PASSWORD 'migrator_dev_password' CREATEDB CREATEROLE;
GRANT ALL PRIVILEGES ON DATABASE omnivo TO omnivo_migrator;
ALTER DATABASE omnivo OWNER TO omnivo_migrator;

CREATE ROLE omnivo_app WITH LOGIN PASSWORD 'app_dev_password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE omnivo TO omnivo_app;
GRANT USAGE ON SCHEMA public TO omnivo_app;

-- omnivo_migrator ভবিষ্যতে যেসব টেবিল/sequence বানাবে, omnivo_app স্বয়ংক্রিয়ভাবে সেগুলোতে অ্যাক্সেস পাবে
ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnivo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO omnivo_app;
