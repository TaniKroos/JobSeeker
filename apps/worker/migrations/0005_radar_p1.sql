-- Priority-1 companies requested 2026-10-06: banks/fintech and consulting. Boards checked to exist that day.
-- (McKinsey isn't here: its careers site refuses automated requests.)
INSERT INTO companies (name, ats, board, priority, created_at) VALUES
  ('JPMorgan Chase', 'oracle', 'jpmc.fa.oraclecloud.com/CX_1001', 1, 0),
  ('American Express', 'oracle', 'egug.fa.us2.oraclecloud.com/CX_1', 1, 0),
  ('BNY', 'oracle', 'eofe.fa.us2.oraclecloud.com/BNY-Careers', 1, 0),
  ('Walmart', 'workday', 'walmart.wd504.myworkdayjobs.com/walmart/WalmartExternal', 1, 0),
  ('Amex GBT', 'workday', 'travelhrportal.wd1.myworkdayjobs.com/travelhrportal/Jobs', 1, 0),
  ('Bain & Company', 'bain', 'bain', 1, 0)
ON CONFLICT (ats, board) DO UPDATE SET priority = 1, active = 1;

UPDATE companies SET priority = 1 WHERE ats = 'workday' AND board IN (
  'visa.wd5.myworkdayjobs.com/visa/Visa',
  'mastercard.wd1.myworkdayjobs.com/mastercard/CorporateCareers',
  'barclays.wd3.myworkdayjobs.com/barclays/External_Career_Site_Barclays',
  'ms.wd5.myworkdayjobs.com/ms/External'
);
