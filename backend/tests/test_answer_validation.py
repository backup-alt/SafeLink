from unittest import TestCase
from backend.ai.groq_agent import unsupported_dates


class DateValidationTests(TestCase):
    def test_rejects_changed_source_year(self):
        source = [{'first_time': '2026-09-04T00:00:00Z'}]
        self.assertEqual({'2024-09-04'}, unsupported_dates('Forecast: 2024‑09‑04', source))
        self.assertEqual(set(), unsupported_dates('Forecast: 2026-09-04', source))
