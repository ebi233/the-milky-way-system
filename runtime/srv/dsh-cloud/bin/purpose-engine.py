#!/usr/bin/env python3
"""Retired legacy generator; scheduled summarization must not invent facts or desires."""
import json

if __name__ == '__main__':
    print(json.dumps({"status": "retired", "modelCalls": 0,
                      "reason": "Use scoped conversation records, evidence notes and activity-plan."}))
