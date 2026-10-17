SELECT 
'CREATE DATABASE wagering_test'
WHERE
NOT EXISTS (SELECT FROM pg_database WHERE datname = 'wagering_test')\gexec