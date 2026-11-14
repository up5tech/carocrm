\set ON_ERROR_STOP on

-- Run as the installation database owner, after selecting the dedicated CaroCRM database.
-- One-time role setup for a fresh dedicated application database. Run interactively; passwords are
-- read with echo disabled and never passed as command-line arguments. The database owner must already
-- have selected the dedicated database. Existing databases need a separately reviewed ownership
-- transition before this migrator role can alter objects created by a different role.
\set app_role carocrm_app
\set migrator_role carocrm_migrator
\prompt -s 'Application role password: ' app_password
\prompt -s 'Migration role password: ' migrator_password
SELECT current_database() AS db_name \gset

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOCREATEDB NOCREATEROLE NOREPLICATION', :'app_role', :'app_password') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOCREATEDB NOCREATEROLE NOREPLICATION', :'migrator_role', :'migrator_password') \gexec

GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";
GRANT CONNECT, CREATE ON DATABASE :"db_name" TO :"migrator_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT CREATE, USAGE ON SCHEMA public TO :"migrator_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
