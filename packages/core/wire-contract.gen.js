// packages/core/wire-contract.gen.js — GENERATED FILE. DO NOT EDIT.
//
// GENERATED from packages/wire-contract/contract.json — edit the contract, then:
//   node packages/wire-contract/gen/gen-kit.js
//
// These constants are the half of the service contract the kit has to know: the tool names
// that go on the wire, the request caps a filing is refused against locally, the timing
// defaults the automatic wait chain assumes, the credential/MCP search orders, and the
// install lineage older generations left behind. Each one used to be a literal in this
// directory AND a literal in the service — two copies, no tripwire between them.
//
// This file is CHECKED IN and shipped inside the kit's npm tarball on purpose: the tarball
// must stay self-contained, so packages/core/wire.js requires this sibling, never the
// workspace package that generated it. packages/wire-contract/contract-sync-selftest.js
// byte-compares this file against a fresh render and fails on drift.
"use strict";

/** The contract revision these constants were generated from. */
const CONTRACT = "pingfusi/wire-contract@1";

// Every canonical tool the service registers, keyed by the kit's INTERNAL verb name.
// wireName is frozen: shipped installs, published tasks, and released iOS builds all speak
// it. aliases are the service's job-named registrations over the same schema and handler.
// kitRemap=false means there is no kit-side verb for it today (it stays out of the remap
// table below) — the name is still contract, because the service registers it.
const TOOLS = {
  "request_review": {
    "wireName": "cpyany_test",
    "frozen": true,
    "kitRemap": true,
    "aliases": [
      "pingfusi_review_website",
      "pingfusi_compare_clone",
      "pingfusi_review_video"
    ]
  },
  "get_test_results": {
    "wireName": "cpyany_test_results",
    "frozen": true,
    "kitRemap": true,
    "aliases": [
      "pingfusi_review_results"
    ]
  },
  "wait_for_results": {
    "wireName": "cpyany_wait",
    "frozen": true,
    "kitRemap": true,
    "aliases": [
      "pingfusi_wait"
    ]
  },
  "quick_poll": {
    "wireName": "cpyany_poll",
    "frozen": true,
    "kitRemap": true,
    "aliases": [
      "pingfusi_quick_question"
    ]
  },
  "get_ping": {
    "wireName": "cpyany_poll_results",
    "frozen": true,
    "kitRemap": true,
    "aliases": [
      "pingfusi_quick_question_results"
    ]
  },
  "check_source": {
    "wireName": "cpyany_check_source",
    "frozen": true,
    "kitRemap": false,
    "aliases": [
      "pingfusi_check_source"
    ]
  }
};

// The remap the kit applies right before a live fetch. The kit's own call sites, its
// file:// fixture filenames, and its selftests all use the INTERNAL verb; only the method
// name on the wire is remapped. A live call with an internal name fails "Tool not found"
// even with a valid token — confirmed empirically, which is why this table exists.
const LIVE_TOOL_NAME = {
  "request_review": "cpyany_test",
  "get_test_results": "cpyany_test_results",
  "wait_for_results": "cpyany_wait",
  "quick_poll": "cpyany_poll",
  "get_ping": "cpyany_poll_results"
};

/** Every canonical wire name (what tools/list returns, minus the job-named aliases). */
const WIRE_TOOL_NAMES = [
  "cpyany_test",
  "cpyany_test_results",
  "cpyany_wait",
  "cpyany_poll",
  "cpyany_poll_results",
  "cpyany_check_source"
];

/** Every job-named alias registration, grouped by the tool it aliases. */
const ALIAS_TOOL_NAMES = [
  "pingfusi_review_website",
  "pingfusi_compare_clone",
  "pingfusi_review_video",
  "pingfusi_review_results",
  "pingfusi_wait",
  "pingfusi_quick_question",
  "pingfusi_quick_question_results",
  "pingfusi_check_source"
];

// The service's round-filing caps, mirrored kit-side so a too-big filing is a NAMED local
// failure before any bytes move. A round past 20 steps, or a step past 300 chars, is
// rejected WHOLE with a Zod "too_big" — not a graceful degrade.
const SERVICE_CAPS = {
  "maxSteps": 20,
  "maxStepTextChars": 300,
  "maxOptionChars": 40
};

// The closed range the service accepts for n_target. SERVICE_CAPS above deliberately does
// NOT carry these two: it is the object the kit hands to its own filing-shape checker, and
// it has held exactly those three caps since the core extraction.
/** How many independent results a round asks for when the caller does not say. */
const DEFAULT_REVIEW_RESULTS = 1;
/** The upper end of the same range. */
const MAX_REVIEW_RESULTS = 20;

/** The service's default renewable idle lease for agent-filed work. */
const DEFAULT_AGENT_LEASE_SECONDS = 60;

/** One server leg must return before common MCP hosts' ~60s hard timeout. */
const DEFAULT_WAIT_LEG_SECONDS = 45;

// SEARCH ORDERS — the order is the contract, not just the membership. Current generation
// first, older generations after, so upgrading never forces a re-login. The two orders
// differ today; that difference is carried verbatim from the contract.
/** ~/.config/<dir>/credentials.json, in the order they are tried. */
const CREDS_DIRS = [
  "pingfusi",
  "pinghumans",
  "cpyany"
];
/** ~/.claude.json mcpServers keys, in the order they are tried. */
const MCP_SERVER_KEYS = [
  "pingfusi",
  "cpyany",
  "pinghumans"
];

// Install identity per product surface: the name the CURRENT generation writes, plus the
// names older generations wrote that a setup/remove has to sweep. An install already on
// disk is the other half of this contract — sweeps may gain entries, never lose one.
const LINEAGE = {
  "mcpServerNames": {
    "current": "pingfusi",
    "sweeps": [
      "cpyany",
      "pinghumans"
    ]
  },
  "credsDirs": {
    "current": "pingfusi",
    "sweeps": [
      "pinghumans",
      "cpyany"
    ]
  },
  "ruleFiles": {
    "claude-code": {
      "current": "pingfusi.md",
      "sweeps": [
        "cpyany.md"
      ]
    },
    "cursor": {
      "current": "pingfusi.mdc",
      "sweeps": [
        "cpyany.mdc"
      ]
    }
  },
  "skillDirs": {
    "claude-code": {
      "current": "pingfusi-review",
      "sweeps": [
        "cpyany"
      ]
    },
    "cursor": {
      "current": "pingfusi-review",
      "sweeps": [
        "cpyany"
      ]
    }
  }
};

module.exports = {
  CONTRACT,
  TOOLS,
  LIVE_TOOL_NAME,
  WIRE_TOOL_NAMES,
  ALIAS_TOOL_NAMES,
  SERVICE_CAPS,
  DEFAULT_REVIEW_RESULTS,
  MAX_REVIEW_RESULTS,
  DEFAULT_AGENT_LEASE_SECONDS,
  DEFAULT_WAIT_LEG_SECONDS,
  CREDS_DIRS,
  MCP_SERVER_KEYS,
  LINEAGE,
};
