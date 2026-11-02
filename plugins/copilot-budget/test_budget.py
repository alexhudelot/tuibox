import unittest

from budget import dock_line, render, risk

SNAP = {"plan": {"usedPercent": 41.6}, "today": 3.0, "agents": [{"label": "main", "context": 40}],
        "forecast": {"projected": 198, "capAt": 1793000000000, "target": 100, "used": 41.6, "pace": 30},
        "jira": {"issues": [{"key": "ABC-1", "summary": "Do a thing"}]}}


class BudgetPy(unittest.TestCase):
    def test_risk_matches_node_thresholds(self):
        self.assertIsNone(risk(None))
        self.assertEqual(risk({"projected": 101, "target": 100}), "RISK")
        self.assertEqual(risk({"projected": 90, "target": 80}), "WATCH")
        self.assertEqual(risk({"projected": 50, "target": 100, "used": 41, "pace": 30}), "WATCH")
        self.assertEqual(risk({"projected": 50, "target": 100, "dailyTarget": 2}, today=3), "WATCH")
        self.assertEqual(risk({"projected": 50, "target": 100, "used": 10, "pace": 20}), "OK")

    def test_dock_line(self):
        self.assertEqual(dock_line(None), "AIC --")
        self.assertEqual(dock_line(SNAP), "AIC 42% →198% RISK")

    def test_render_exact_size_any_data(self):
        for data, state in ((SNAP, "ok"), (None, "off"), ({"plan": {"usedPercent": float("nan")}}, "stale")):
            for w in range(0, 90, 7):
                for h in range(0, 30, 3):
                    view = render(data, state, w, h, now=0)
                    self.assertEqual(len(view), h)
                    self.assertTrue(all(len(l) == w for l in view), (w, h))

    def test_risk_prefix_first_line(self):
        self.assertTrue(render(SNAP, "ok", 30, 5, now=0)[0].startswith("! PLAN RISK"))


if __name__ == "__main__":
    unittest.main()
