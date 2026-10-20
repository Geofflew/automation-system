-- Unqualified names on purpose: the runner sets search_path, so the same files build the live
-- schema, a test schema, or the scratch schema the drift check compares against.
CREATE TABLE companies (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE deals (
  id int PRIMARY KEY,
  company_id int REFERENCES companies (id),
  stage text NOT NULL,
  amount numeric(12, 2) NOT NULL
);
