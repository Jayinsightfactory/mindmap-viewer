'use strict';
/**
 * src/palantir-integration.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Palantir-inspired Integration Layer for Orbit AI
 *
 * Architecture patterns from Palantir Foundry/Gotham/AIP:
 *   1. Ontology Augmented Generation (OAG) — structured entity injection to LLM
 *   2. Agent Memory Tiers — working, episodic, semantic, procedural
 *   3. Closed-loop Feedback — propose → accept/reject → record → improve
 *   4. Knowledge Graph — entity relationships for work patterns
 *   5. Multi-agent Orchestration — coordinate AI agents
 *
 * Used by: routes/ontology.js, orbit3d-monitor.js, growth-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ═══ 1. Personalized Learning Engine ═════════════════════════════════════════
// Palantir Foundry pattern: learn from user actions → recommend tools/schedule

class PersonalLearningEngine {
  constructor(db) {
    this.db = db;
    this._ensureTables();
  }

  _ensureTables() {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_work_patterns (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL,
          pattern_type TEXT NOT NULL,
          data_json   TEXT DEFAULT '{}',
          confidence  REAL DEFAULT 0.5,
          created_at  TEXT DEFAULT (datetime('now')),
          updated_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_recommendations (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          type         TEXT NOT NULL,
          title        TEXT NOT NULL,
          description  TEXT,
          accepted     INTEGER DEFAULT 0,
          rejected     INTEGER DEFAULT 0,
          created_at   TEXT DEFAULT (datetime('now'))
        );
      `);
    } catch {}
  }

  // Analyze user's work time patterns → recommend optimal hours
  analyzeWorkSchedule(events, userId) {
    const hourBuckets = new Array(24).fill(0);
    for (const ev of events) {
      const h = new Date(ev.timestamp).getHours();
      hourBuckets[h]++;
    }

    // Find peak productivity hours (top 3)
    const ranked = hourBuckets
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count);

    const peakHours = ranked.slice(0, 3).map(r => r.hour);
    const lowHours  = ranked.slice(-3).map(r => r.hour);

    return {
      userId,
      peakHours,
      lowHours,
      recommendation: `최적 작업 시간: ${peakHours.map(h => `${h}시`).join(', ')}`,
      totalEvents: events.length,
    };
  }

  // Analyze tool usage → recommend tools
  analyzeToolUsage(events, userId) {
    const tools = {};
    for (const ev of events) {
      const tool = ev.data?.toolName || ev.data?.app || ev.type;
      if (!tool) continue;
      if (!tools[tool]) tools[tool] = { count: 0, duration: 0 };
      tools[tool].count++;
      tools[tool].duration += ev.data?.duration || 0;
    }

    const sorted = Object.entries(tools)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.count - a.count);

    return {
      userId,
      topTools: sorted.slice(0, 5),
      underutilized: sorted.filter(t => t.count < 3 && t.count > 0),
    };
  }
}

// ═══ 2. Auto Python Program Generator ════════════════════════════════════════
// Palantir AIP pattern: detect repetitive work → auto-generate automation scripts

class AutoScriptGenerator {
  // Detect repeated patterns and generate script suggestions
  static detectAndSuggest(events) {
    const suggestions = [];

    // Pattern: same file modified many times → suggest watcher script
    const fileEdits = {};
    for (const ev of events) {
      if (ev.type !== 'file.write' && ev.type !== 'vscode.file_save') continue;
      const f = ev.data?.fileName || ev.data?.filePath;
      if (!f) continue;
      fileEdits[f] = (fileEdits[f] || 0) + 1;
    }

    for (const [file, count] of Object.entries(fileEdits)) {
      if (count >= 5) {
        suggestions.push({
          type: 'file_watcher',
          title: `${file} 자동 처리 스크립트`,
          description: `${count}번 수정된 파일. 변경 감지 자동화를 추천합니다.`,
          script: `#!/usr/bin/env python3
"""Auto-generated: Watch and process ${file}"""
import time, os
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class Handler(FileSystemEventHandler):
    def on_modified(self, event):
        if event.src_path.endswith('${file.split('/').pop()}'):
            print(f"Changed: {event.src_path}")
            # TODO: Add your processing logic here

if __name__ == '__main__':
    observer = Observer()
    observer.schedule(Handler(), path='.', recursive=True)
    observer.start()
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
`,
        });
      }
    }

    // Pattern: repeated terminal commands → suggest shell alias
    const cmds = {};
    for (const ev of events) {
      if (ev.type !== 'terminal.command') continue;
      const cmd = ev.data?.command;
      if (!cmd || cmd.length < 5) continue;
      const key = cmd.slice(0, 60);
      cmds[key] = (cmds[key] || 0) + 1;
    }

    for (const [cmd, count] of Object.entries(cmds)) {
      if (count >= 3) {
        suggestions.push({
          type: 'shell_alias',
          title: '반복 명령 자동화',
          description: `"${cmd.slice(0, 40)}..." 명령을 ${count}번 반복 실행했습니다.`,
          script: `# Add to ~/.zshrc or ~/.bashrc\nalias orbit_auto='${cmd}'`,
        });
      }
    }

    return suggestions;
  }
}

// ═══ 3. Agent Orchestration Layer ════════════════════════════════════════════
// Palantir AIP pattern: coordinate multiple AI agents

class AgentOrchestrator {
  constructor() {
    this.agents = new Map();  // agentId → { status, lastEvent, memory }
    this.conversations = [];  // inter-agent conversations
  }

  registerAgent(agentId, config) {
    this.agents.set(agentId, {
      ...config,
      status: 'idle',
      lastEvent: null,
      memory: {
        working: {},    // Current task context
        episodic: [],   // Past interactions (last 100)
        semantic: {},   // Knowledge base entries
        procedural: [], // Learned rules/workflows
      },
    });
  }

  // Update agent status from monitor events
  updateAgentStatus(agentId, event) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.status = 'active';
    agent.lastEvent = { text: event.text || event.type, ts: Date.now() };

    // Add to episodic memory
    agent.memory.episodic.unshift({ event: event.type, data: event.data, ts: Date.now() });
    if (agent.memory.episodic.length > 100) agent.memory.episodic.length = 100;
  }

  // Inter-agent discussion: one agent asks another for input
  requestDiscussion(fromAgent, toAgent, topic) {
    const conv = {
      id: Date.now().toString(36),
      from: fromAgent,
      to: toAgent,
      topic,
      status: 'pending',
      messages: [{ role: fromAgent, text: topic, ts: Date.now() }],
    };
    this.conversations.push(conv);
    if (this.conversations.length > 100) this.conversations = this.conversations.slice(-50);
    return conv;
  }

  // Get all agent statuses for monitor display
  getAllStatuses() {
    const result = {};
    for (const [id, agent] of this.agents) {
      result[id] = {
        status: agent.status,
        lastEvent: agent.lastEvent,
        memorySize: {
          episodic: agent.memory.episodic.length,
          semantic: Object.keys(agent.memory.semantic).length,
          procedural: agent.memory.procedural.length,
        },
      };
    }
    return result;
  }
}

// ═══ 4. Feedback Loop System ═════════════════════════════════════════════════
// Palantir pattern: propose → measure → record → improve

class FeedbackLoop {
  constructor(db) {
    this.db = db;
  }

  // Record an AI evaluation result
  recordOutcome(suggestionId, outcome) {
    // outcome: { accepted: bool, effectiveness: 0-1, userNotes: string }
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO user_recommendations (id, user_id, type, title, accepted, rejected)
        VALUES (?, 'system', 'outcome', ?, ?, ?)
      `).run(
        suggestionId,
        outcome.userNotes || '',
        outcome.accepted ? 1 : 0,
        outcome.accepted ? 0 : 1
      );
    } catch {}
    return { ok: true };
  }

  // Calculate improvement metrics
  getImprovementMetrics(userId) {
    if (!this.db) return { acceptRate: 0, totalSuggestions: 0 };
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN accepted > 0 THEN 1 ELSE 0 END) as accepted
        FROM user_recommendations WHERE user_id = ?
      `).get(userId || 'system');
      return {
        acceptRate: row.total > 0 ? Math.round((row.accepted / row.total) * 100) : 0,
        totalSuggestions: row.total,
      };
    } catch {
      return { acceptRate: 0, totalSuggestions: 0 };
    }
  }
}

// ═══ Exports ═════════════════════════════════════════════════════════════════

module.exports = {
  PersonalLearningEngine,
  AutoScriptGenerator,
  AgentOrchestrator,
  FeedbackLoop,
};
