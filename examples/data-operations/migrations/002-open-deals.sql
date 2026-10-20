-- Open pipeline: every deal still being worked.
CREATE VIEW open_deals AS
SELECT d.id, c.name AS company, d.stage, d.amount
FROM deals d
JOIN companies c ON c.id = d.company_id
WHERE d.stage <> 'lost';
