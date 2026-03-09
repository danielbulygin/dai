# Creative Workspace — Master Specification

> This document is the single source of truth for the Creative Workspace. Each phase is self-contained — a fresh Claude session can read this spec and execute any phase independently.

## Vision

A collaborative platform where creative strategists and AI agents work together on briefs, from ideation to production handoff. One place to organize, generate, edit, review, and track ad briefs — with Maya as an always-available creative partner.

### Problem

- **Brief Studio** (BMAD) generates briefs in a 6-step wizard, but it's a one-shot tool — no persistent workspace, no collaboration, no iteration after export
- **Maya** (DAI) has deep creative intelligence (format x angle framework, diversity scoring, methodology knowledge) but is only accessible via Slack
- **Notion** is the document layer, but has no AI integration and no structured creative workflow
- **QC is ad hoc** — Zyra reviews in Notion/Slack with no structured approval pipeline
- **No live collaboration** — Franzi, Mikel, editors, and creators can't co-edit simultaneously
- **Files scattered** across Notion, Slack threads, Google Docs, and the BMAD dashboard

### What Makes This Different From Brief Studio

Brief Studio is a **generation wizard** — you go through 6 steps, export, done. The Creative Workspace is a **persistent environment** — briefs live here, get iterated on, go through QC, get assigned to creators, and track all the way to live ads. Maya is embedded in the editor, not just the generation step.

---

## Architecture Decisions (Resolved)

1. **Separate Next.js app** — lives in BMAD repo at `pma/workspace/`, shares BMAD Supabase. Different UX needs than the analytics dashboard. Deployed to Vercel independently.
2. **Hocuspocus self-hosted on DO** — runs alongside DAI on the existing droplet. Small team (~10 users), no need for managed service.
3. **Brief Studio coexists** — keep it as a quick-generation shortcut, gradually deprecated as workspace matures.
4. **Notion export retained** — primary handoff mechanism initially, production tracking shifts to workspace over time.
5. **Client access: approved briefs only** — read-only with commenting. Invite via shareable link with Supabase Auth.
6. **Offline support deferred** — Yjs supports it, but not worth the complexity for a team that's always online.

---

## Tech Stack

| Layer | Choice | Version |
|-------|--------|---------|
| Framework | Next.js (App Router) | ^16.x (match BMAD) |
| React | React | ^18 |
| Editor | Tiptap + ProseMirror | @tiptap/react ^2.x |
| Real-time | Yjs + @hocuspocus/server | latest |
| UI | Tailwind CSS + CSS variables | ^3.3 (match BMAD) |
| Icons | Lucide React | match BMAD |
| Animations | Framer Motion | match BMAD |
| State | Zustand (client) + React Query (server) | latest |
| Database | BMAD Supabase (shared) | @supabase/ssr ^0.8 |
| AI Backend | DAI API (new HTTP layer) | Express/Hono on DO |
| Auth | Supabase Auth (magic link + Google) | via @supabase/ssr |
| Storage | Supabase Storage | for images/assets |
| Charts | Recharts | match BMAD |
| Deploy | Vercel (frontend) + DO (API + Hocuspocus) | existing infra |

---

## Data Model

All tables live in **BMAD Supabase** (bzhqvxknwvxhgpovrhlp). Existing tables (`clients`, `concepts`, `briefs`, `creatives`) are extended, not replaced.

### Existing Tables (Already in BMAD)

**clients** — `id`, `code`, `name`, `brand_emoji`, `status`, etc.
**concepts** — `id`, `client_id`, `title`, `description`, `dials` (JSONB), `hooks` (JSONB[]), `angle`, `format`, `hook_type`, `target_emotion`, `status` (draft|pitched|approved|rejected|on_hold), etc.
**briefs** — `id`, `client_id`, `concept_id` (FK), `brief_code`, `title`, `content` (markdown), `dials` (JSONB), `hooks` (JSONB[]), `assigned_creator`, `due_date`, `status`, etc.

### New Columns on `briefs` (Phase 1 Migration)

```sql
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS
  editor_content JSONB,           -- Tiptap JSON document (structured editor state)
  template_id TEXT,                -- Template used to create this brief
  format_code TEXT,                -- F01-F17 (Maya coordinate)
  angle_code TEXT,                 -- A01-A15 (Maya coordinate)
  style_tags TEXT[],               -- ['lo-fi', 'energetic']
  funnel_stage TEXT,               -- tof | mof | bof
  created_by_user UUID,            -- Supabase Auth user ID
  updated_by_user UUID,
  updated_at TIMESTAMPTZ DEFAULT NOW();
```

### New Tables

```sql
-- Phase 1: Workspace users (maps Supabase Auth to workspace roles)
CREATE TABLE workspace_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  auth_id UUID NOT NULL UNIQUE,         -- Supabase Auth user ID
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'strategist', -- admin | lead | strategist | qc | creator | client
  client_scope TEXT[],                   -- Client codes this user can access (NULL = all)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 3: Comments
CREATE TABLE brief_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brief_id UUID NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES workspace_users(id),
  content TEXT NOT NULL,
  selection_json JSONB,                  -- Tiptap position data for inline comments
  parent_id UUID REFERENCES brief_comments(id), -- Thread replies
  resolved BOOLEAN DEFAULT FALSE,
  resolved_by UUID REFERENCES workspace_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 3: Version history
CREATE TABLE brief_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brief_id UUID NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  editor_content JSONB NOT NULL,         -- Snapshot of Tiptap document
  changed_by UUID NOT NULL REFERENCES workspace_users(id),
  change_summary TEXT,                   -- Auto-generated or manual
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 2: AI chat sessions per brief
CREATE TABLE brief_chats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brief_id UUID REFERENCES briefs(id) ON DELETE CASCADE,
  client_code TEXT NOT NULL,             -- For brief-less chats (concept generation)
  user_id UUID NOT NULL REFERENCES workspace_users(id),
  dai_session_id TEXT,                   -- Maps to DAI session for continuity
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brief_chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES brief_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                    -- user | assistant
  content TEXT NOT NULL,
  metadata JSONB,                        -- Tool calls, suggestions, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 3: Real-time document state (Yjs)
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS
  yjs_state BYTEA;                       -- Yjs encoded document state

-- Phase 4: QC workflow columns
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS
  assigned_qc UUID REFERENCES workspace_users(id),
  qc_checklist JSONB,                    -- [{rule, status: pass|warn|fail, note}]
  approved_by UUID[],                    -- Array of approver user IDs
  approved_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ;

-- Phase 5: Performance tracking
CREATE TABLE brief_tracking (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brief_id UUID NOT NULL REFERENCES briefs(id),
  ad_id TEXT,                            -- Meta ad ID (filled when ad goes live)
  performance_grade TEXT,                -- A-F (synced from creative analytics)
  performance_data JSONB,                -- Hook/watch/click/convert scores
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  scored_at TIMESTAMPTZ
);
```

### RLS Policies (Phase 1)

```sql
-- workspace_users: users can read all, only admins can modify
ALTER TABLE workspace_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read all workspace users" ON workspace_users FOR SELECT USING (true);
CREATE POLICY "Admins can manage users" ON workspace_users FOR ALL USING (
  EXISTS (SELECT 1 FROM workspace_users WHERE auth_id = auth.uid() AND role = 'admin')
);

-- briefs: client-scoped users only see their clients
CREATE POLICY "Users see briefs for their clients" ON briefs FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM workspace_users
    WHERE auth_id = auth.uid()
    AND (client_scope IS NULL OR client_id::text = ANY(client_scope))
  )
);
```

---

## Phase 1: Workspace Shell + Brief Editor

**Goal:** A working brief editor with client navigation, templates, and persistence. No AI, no collaboration — just a solid document editing experience.

**Prerequisites:** BMAD Supabase access, Vercel account.

### 1A. Project Scaffold

Create the Next.js app at `pma/workspace/`:

```
pma/workspace/
├── package.json
├── next.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── .env.local.example
├── src/
│   ├── app/
│   │   ├── layout.tsx              -- Root layout (sidebar + main)
│   │   ├── page.tsx                -- Dashboard / home (redirect to first client)
│   │   ├── login/
│   │   │   └── page.tsx            -- Magic link login
│   │   ├── [clientCode]/
│   │   │   ├── layout.tsx          -- Client workspace layout
│   │   │   ├── page.tsx            -- Brief list for this client
│   │   │   └── [briefId]/
│   │   │       └── page.tsx        -- Brief editor page
│   │   └── api/
│   │       └── auth/
│   │           └── callback/
│   │               └── route.ts    -- Supabase auth callback
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx         -- Client list sidebar
│   │   │   ├── Header.tsx          -- Top bar (user, search, new brief)
│   │   │   └── ClientNav.tsx       -- Client workspace nav
│   │   ├── briefs/
│   │   │   ├── BriefList.tsx       -- Grid/list of briefs
│   │   │   ├── BriefCard.tsx       -- Brief card component
│   │   │   ├── NewBriefDialog.tsx  -- Create brief modal (template picker)
│   │   │   └── StatusBadge.tsx     -- Status pill component
│   │   └── editor/
│   │       ├── BriefEditor.tsx     -- Main editor wrapper
│   │       ├── EditorToolbar.tsx   -- Formatting toolbar
│   │       ├── SectionBlock.tsx    -- Collapsible brief section
│   │       └── extensions/
│   │           ├── brief-section.ts   -- Custom Tiptap node for sections
│   │           ├── dial-block.ts      -- Custom node for dial sliders
│   │           └── hook-block.ts      -- Custom node for hook options
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts           -- Browser client (singleton)
│   │   │   ├── server.ts           -- Server client (for RSC/API routes)
│   │   │   └── middleware.ts        -- Auth middleware
│   │   ├── types.ts                -- TypeScript interfaces
│   │   ├── templates/
│   │   │   ├── index.ts            -- Template registry
│   │   │   ├── ugc-video.ts        -- UGC video brief template (Tiptap JSON)
│   │   │   ├── static.ts           -- Static image brief template
│   │   │   ├── motion.ts           -- Motion graphics template
│   │   │   └── carousel.ts         -- Carousel template
│   │   └── constants.ts            -- Format codes, angle codes, status list
│   ├── middleware.ts                -- Next.js middleware (auth guard)
│   └── styles/
│       └── globals.css             -- CSS variables (match BMAD theme)
└── public/
    └── ...
```

**Key dependencies:**
```json
{
  "@tiptap/react": "^2.x",
  "@tiptap/starter-kit": "^2.x",
  "@tiptap/extension-placeholder": "^2.x",
  "@tiptap/extension-image": "^2.x",
  "@tiptap/extension-task-list": "^2.x",
  "@tiptap/extension-task-item": "^2.x",
  "@supabase/ssr": "^0.8.0",
  "@supabase/supabase-js": "^2.39.0",
  "next": "^16.1.1",
  "react": "^18",
  "tailwindcss": "^3.3.0",
  "lucide-react": "latest",
  "framer-motion": "latest",
  "zustand": "latest"
}
```

### 1B. Supabase Migration

Run on BMAD Supabase:
- Add new columns to `briefs` table (editor_content, format_code, angle_code, style_tags, funnel_stage, created_by_user, updated_by_user, updated_at)
- Create `workspace_users` table
- Set up RLS policies
- Seed initial workspace_users (Daniel as admin, Franzi as lead)

### 1C. Auth Flow

- Supabase Auth with magic link (email) — same setup as BMAD dashboard
- Middleware redirects unauthenticated users to `/login`
- After login, look up `workspace_users` by `auth_id` to get role and client_scope
- If no workspace_user record exists, show "Access denied — contact admin" page

### 1D. Client Sidebar

- Server component: fetch all clients from BMAD `clients` table (code, name, brand_emoji)
- Sidebar shows client list with emoji + name
- Active client highlighted
- Brief count badge per client
- "All Briefs" option at top
- Collapsible on mobile

### 1E. Brief List Page (`/[clientCode]`)

- Server component: fetch briefs for this client, ordered by updated_at desc
- Filters: status (draft, in_review, approved, in_production, completed), search (title)
- Grid view: BriefCard components
  - Title, format badge (e.g., "F01 Talking Head"), angle badge, status pill
  - Updated date, assignee avatar if assigned
  - Click to open editor
- "New Brief" button opens NewBriefDialog

### 1F. New Brief Dialog

- Select template: UGC Video, Static, Motion Graphics, Carousel, Blank
- Auto-generates brief_code from client code + sequential number (e.g., NP-043)
- Creates brief row in Supabase with `editor_content` = template JSON
- Redirects to editor page

### 1G. Brief Editor

The core of Phase 1. A Tiptap editor with custom nodes for brief structure.

**Document structure (Tiptap JSON):**
```json
{
  "type": "doc",
  "content": [
    {
      "type": "briefSection",
      "attrs": { "id": "overview", "title": "Overview", "collapsed": false },
      "content": [
        { "type": "paragraph", "content": [{ "type": "text", "text": "..." }] }
      ]
    },
    {
      "type": "briefSection",
      "attrs": { "id": "dials", "title": "Creative Dials" },
      "content": [
        { "type": "dialBlock", "attrs": { "dials": { ... } } }
      ]
    },
    {
      "type": "briefSection",
      "attrs": { "id": "hooks", "title": "Hooks" },
      "content": [
        { "type": "hookBlock", "attrs": { "hooks": [...] } }
      ]
    }
  ]
}
```

**Custom Tiptap extensions:**
- `BriefSection` — collapsible container with title, id, collapse toggle
- `DialBlock` — renders 5 sliders with labels and values (interactive, saves to attrs)
- `HookBlock` — renders hook A/B/C with editable text + rationale fields

**Standard Tiptap extensions (from starter-kit):**
- Headings (H1-H3), paragraphs, bullet/numbered lists, blockquote, code block
- Bold, italic, strikethrough, highlight
- Image (for visual references)
- Task list (for QC checklists later)
- Placeholder ("Start typing...")

**Toolbar:**
- Formatting buttons (B, I, S, highlight)
- Block type dropdown (paragraph, H1, H2, H3, bullet list, numbered list, quote)
- Insert: image, divider, table
- Section jump dropdown (quick navigation between brief sections)

**Persistence:**
- Auto-save on change (debounced 2s) via Supabase update
- Save `editor_content` (Tiptap JSON) and `content` (markdown export for backwards compat)
- Save indicator: "Saved" / "Saving..." / "Unsaved changes"
- Last saved timestamp in header

**Brief metadata sidebar (right side):**
- Brief code (read-only)
- Status dropdown
- Format code selector (F01-F17 with labels)
- Angle code selector (A01-A15 with labels)
- Style tags (multi-select chips)
- Funnel stage (TOF/MOF/BOF toggle)
- Assigned creator (user picker)
- Due date picker
- Created/updated timestamps

### 1H. Acceptance Criteria

- [ ] Can log in with magic link, see client sidebar
- [ ] Can navigate between clients, see their briefs
- [ ] Can create a new brief from template
- [ ] Can edit brief in Tiptap editor with all standard formatting
- [ ] Brief sections are collapsible
- [ ] Dial sliders are interactive and persist
- [ ] Hook blocks render A/B/C options
- [ ] Auto-saves to Supabase within 2s of changes
- [ ] Can set metadata (format code, angle code, status, etc.)
- [ ] Brief list shows status badges, format/angle pills
- [ ] Auth works: unauthenticated users redirected, role-based access enforced
- [ ] Mobile responsive (sidebar collapses, editor adapts)

---

## Phase 2: Maya Integration

**Goal:** Maya is available as an AI collaborator within the workspace — chat sidebar, concept generation, and inline AI actions.

**Prerequisites:** Phase 1 complete, DAI running on DO.

### 2A. DAI API Layer (in DAI repo)

New HTTP server in DAI that wraps `runAgent()` for web clients:

```
src/
├── api/
│   ├── server.ts           -- Express/Hono HTTP server (separate from Slack bot)
│   ├── routes/
│   │   ├── chat.ts          -- POST /api/chat (streaming SSE)
│   │   ├── concepts.ts      -- POST /api/generate-concepts
│   │   └── health.ts        -- GET /api/health
│   └── auth.ts              -- API key or JWT validation
```

**`POST /api/chat`**
- Request: `{ userId, clientCode, briefId?, message, briefContext? }`
- `briefContext` = current editor_content JSON (so Maya sees what the user is working on)
- Uses `runAgent()` with `agentId: 'maya'`, virtual `channelId: 'web:{userId}'`, `threadTs: briefId`
- Streams response via SSE (Server-Sent Events)
- Maya has access to all her tools: ask_ada, search_methodology, get_creative_audit, get_creative_diversity_score, memory, Slack, Notion, Fireflies

**`POST /api/generate-concepts`**
- Request: `{ clientCode, dials, direction?, count, briefType }`
- Wraps a Maya call with a concept-generation-specific system prompt prefix
- Returns: `{ concepts: [{ title, format_code, angle_code, hooks, target_emotion, rationale }] }`

**Auth:** API key in header (`X-API-Key`), validated against env var. Simple and sufficient for an internal tool.

**Deployment:** Add HTTP server to DAI's `src/index.ts` startup (runs alongside Slack bot on a different port, e.g., 3001). Expose via Caddy/nginx on DO with HTTPS.

### 2B. Chat Sidebar Component

```
src/components/
├── ai/
│   ├── ChatSidebar.tsx         -- Collapsible right panel
│   ├── ChatMessage.tsx         -- Single message (user or Maya)
│   ├── ChatInput.tsx           -- Input with send button
│   ├── StreamingResponse.tsx   -- Renders streaming SSE text
│   └── ToolCallIndicator.tsx   -- Shows "Searching methodology..." etc.
```

**Behavior:**
- Toggle open/close with keyboard shortcut (Cmd+Shift+M) and button
- Chat history loads from `brief_chats` + `brief_chat_messages` tables
- New chat created per brief (or per concept-generation session)
- Messages streamed via SSE from DAI API
- Tool calls shown as collapsible indicators ("Asking Ada for performance data...")
- Maya's responses rendered with markdown (react-markdown)
- Input supports multi-line, Cmd+Enter to send
- Brief context automatically included (current editor content summarized)

**Context injection:**
- When chat is opened on a brief, the first hidden message includes: brief title, client code, format/angle, current content summary
- This gives Maya full context without the user having to explain

### 2C. Concept Generation Flow

Integrated into the workspace as a modal/drawer:

```
src/components/
├── concepts/
│   ├── ConceptGenerationFlow.tsx  -- Multi-step modal
│   ├── DialConfigurator.tsx       -- 5 dial sliders (reuse from Brief Studio)
│   ├── ConceptCard.tsx            -- Single concept with select/skip
│   └── ConceptGrid.tsx            -- Grid of generated concepts
```

**Flow:**
1. Click "New Brief" > "Generate with Maya" (or "From Template" for Phase 1 path)
2. Dial configurator (5 sliders with recommended ranges per client)
3. Optional: discovery chat with Maya in sidebar
4. Click "Generate Concepts" — calls `POST /api/generate-concepts`
5. Concept grid appears: cards with title, format x angle badge, hooks, rationale
6. Select concepts > "Create Briefs" > creates brief documents pre-filled from concept
7. Each selected concept becomes a brief in the workspace with editor_content populated

### 2D. Inline AI Actions

**Selection toolbar:**
- When user selects text in the editor, a floating toolbar appears with:
  - "Ask Maya" — opens chat with selected text as context
  - "Improve" — calls Maya with "Improve this: {selection}"
  - "Shorten" — calls Maya with "Make this more concise: {selection}"
  - "Translate" — calls Maya with "Translate to German/English: {selection}"
- Response streams into chat sidebar
- User can copy/paste or accept suggestion (inserts at cursor)

**Section-level actions:**
- Each briefSection has a sparkle icon: "Generate with Maya"
- Sends section context (which section, surrounding content) to Maya
- Maya generates content appropriate for that section type
- Result appears in chat, with "Insert" button to replace section content

### 2E. Supabase Migration

- Create `brief_chats` and `brief_chat_messages` tables
- RLS: users can read/write their own chats

### 2F. Acceptance Criteria

- [ ] DAI API server starts alongside Slack bot, responds to health check
- [ ] Chat sidebar opens/closes, persists chat history per brief
- [ ] Can send message to Maya, receive streaming response
- [ ] Maya sees brief context (knows which client, brief, and content)
- [ ] Tool calls display as indicators (searching, asking Ada, etc.)
- [ ] Concept generation flow works: dials > generate > select > create briefs
- [ ] Inline "Ask Maya" works on text selection
- [ ] Section-level "Generate" buttons work for each brief section
- [ ] Chat persists across page reloads

---

## Phase 3: Real-Time Collaboration

**Goal:** Multiple users can edit the same brief simultaneously, with presence indicators, comments, and version history.

**Prerequisites:** Phase 1 complete (editor works). Phase 2 nice-to-have but not required.

### 3A. Hocuspocus Server (on DO)

Set up Hocuspocus as a Yjs WebSocket provider:

```
src/collab/
├── server.ts         -- Hocuspocus server config
├── auth.ts           -- Connection authentication (JWT from Supabase)
└── persistence.ts    -- Save Yjs state to Supabase (briefs.yjs_state)
```

**Config:**
- Port 3002 on DO (behind Caddy with WSS on wss://collab.workspace.adsontap.io)
- Authentication: client sends Supabase JWT on WebSocket connect, server validates
- Persistence: on document update (debounced), save Yjs binary state to `briefs.yjs_state`
- Load: on document open, load from `briefs.yjs_state` if exists, else from `briefs.editor_content`
- Document name pattern: `brief:{briefId}`

**Add to DAI `src/index.ts`** or run as separate process with PM2.

### 3B. Tiptap Collaboration Extension

Add to the editor:
```
@tiptap/extension-collaboration       -- Yjs integration
@tiptap/extension-collaboration-cursor -- Multi-cursor + presence
@hocuspocus/provider                   -- WebSocket provider
```

**Editor changes:**
- On mount: create `HocuspocusProvider` with document name `brief:{briefId}`
- Pass Yjs doc to Tiptap `Collaboration` extension
- `CollaborationCursor` extension shows other users' cursors with name + color
- Remove direct Supabase save (Hocuspocus handles persistence now)
- Fallback: if WebSocket disconnects, fall back to direct Supabase save

**Presence UI:**
- Top-right of editor: avatar circles for connected users
- Hover shows name
- Each user gets a consistent color (hash of user ID)
- "X people editing" label

### 3C. Comments System

```
src/components/
├── comments/
│   ├── CommentsSidebar.tsx       -- Right panel (toggles with chat)
│   ├── CommentThread.tsx         -- Single comment + replies
│   ├── InlineCommentMark.tsx     -- Tiptap mark for highlighted text
│   └── NewCommentForm.tsx        -- Input for new comments
```

**Behavior:**
- Select text > click "Comment" in toolbar
- Creates a Tiptap mark (highlight) on the selected range
- Opens comment form in sidebar
- Comment saved to `brief_comments` with `selection_json` (Tiptap position)
- Comments thread: replies nest under parent
- Click highlight in editor > scrolls to comment in sidebar
- Click comment in sidebar > scrolls to highlight in editor
- "Resolve" button dims the highlight and marks resolved
- @mention autocomplete for workspace users

### 3D. Version History

```
src/components/
├── versions/
│   ├── VersionHistory.tsx    -- List of versions with timestamps
│   ├── VersionDiff.tsx       -- Side-by-side or inline diff view
│   └── RestoreButton.tsx     -- Restore to previous version
```

**Auto-snapshot rules:**
- Save version on: status change, every 30 minutes of active editing, manual "Save version" click
- Version includes: editor_content snapshot, changed_by user, auto-generated summary
- Diff view: compare any two versions (text diff of markdown export)
- Restore: creates a new version (doesn't delete history), updates editor_content

### 3E. Supabase Migration

- Add `yjs_state BYTEA` column to `briefs`
- Create `brief_comments` table
- Create `brief_versions` table
- RLS: comments visible to all users with brief access

### 3F. Acceptance Criteria

- [ ] Two users can open same brief, see each other's cursors and edits in real-time
- [ ] Presence indicators show who's connected
- [ ] Can add inline comment on selected text
- [ ] Comment threads with replies work
- [ ] Can resolve/unresolve comments
- [ ] Version history shows snapshots with timestamps and user
- [ ] Can view diff between versions
- [ ] Can restore to a previous version
- [ ] WebSocket reconnects gracefully after network interruption
- [ ] Yjs state persists (reload page, content is there)

---

## Phase 4: QC & Approval Workflow

**Goal:** Structured review pipeline with AI pre-check and human approval gates.

**Prerequisites:** Phase 1 complete. Phase 2 (Maya) needed for AI pre-check.

### 4A. Status Pipeline UI

**Brief status flow:**
```
draft → ready_for_review → in_qc → changes_requested → approved → in_production → live → archived
```

**Status transitions (role-gated):**
| From | To | Who Can |
|------|----|---------|
| draft | ready_for_review | strategist, lead |
| ready_for_review | in_qc | qc, lead, admin |
| in_qc | approved | qc, lead |
| in_qc | changes_requested | qc, lead |
| changes_requested | ready_for_review | strategist, lead |
| approved | in_production | lead, admin |
| in_production | live | lead, admin |
| any | archived | lead, admin |

**UI:**
- Status dropdown in brief metadata panel (right side of editor)
- Transitions show only valid next statuses based on current status + user role
- Confirmation modal for status changes with optional note
- Status history log (who changed when, with notes)
- Brief list page: filter by status, color-coded status pills

### 4B. QC Checklist

```
src/components/
├── qc/
│   ├── QCPanel.tsx           -- QC review panel (replaces metadata sidebar when in_qc)
│   ├── ChecklistItem.tsx     -- Single check item (pass/warn/fail toggle)
│   ├── AIPreCheck.tsx        -- "Run AI Check" button + results
│   └── QCActions.tsx         -- Approve / Request Changes buttons
```

**Auto-generated checklist:**
- When brief enters `in_qc`, generate checklist from:
  1. **Universal rules**: hook count (need 3), script length (format-appropriate), dial alignment
  2. **Client rules**: fetched from client's `client-feedback.md` and `dos-and-donts.md` (BMAD repo)
  3. **Format rules**: based on format_code (e.g., F01 Talking Head needs direct-to-camera direction)
- Store checklist in `briefs.qc_checklist` (JSONB array)
- QC reviewer toggles each item: pass / warning / fail
- Can add notes per item

**AI Pre-Check (requires Phase 2):**
- "Run AI Check" button sends brief content to Maya via DAI API
- Maya prompt: "Review this brief for {clientCode}. Check against brand guidelines, common feedback issues, dial alignment, hook quality, and script clarity. Return a structured checklist."
- Results populate the checklist with AI assessments
- Human reviewer can override AI judgments

### 4C. Approval Gates

- When QC reviewer clicks "Approve", check if additional approvers needed (configurable per client)
- If Franzi approval required: status stays `in_qc` until she approves, notification sent
- Approval stored in `briefs.approved_by` array
- Once all required approvers approve: status auto-advances to `approved`

### 4D. Slack Notifications

Add to DAI (not workspace frontend):
- When brief status changes to `ready_for_review` or `in_qc`: notify assigned QC in Slack DM
- When `changes_requested`: notify brief creator
- When `approved`: notify brief creator + assigned creator
- Use DAI's existing Slack bot token
- Message includes: brief title, client, link to workspace editor

### 4E. Supabase Migration

- Add `assigned_qc`, `qc_checklist`, `approved_by`, `approved_at`, `status_changed_at` to `briefs`
- Create `brief_status_log` table (brief_id, from_status, to_status, user_id, note, created_at)

### 4F. Acceptance Criteria

- [ ] Status dropdown shows valid transitions based on user role
- [ ] Status changes logged with user and timestamp
- [ ] QC checklist auto-generates when brief enters QC
- [ ] QC reviewer can toggle pass/warn/fail per item with notes
- [ ] AI pre-check populates checklist (requires Phase 2)
- [ ] Approve / Request Changes buttons work
- [ ] Multi-approver gates work (waits for all required approvers)
- [ ] Slack notifications fire on status transitions
- [ ] Brief list filterable by status

---

## Phase 5: Creative Intelligence

**Goal:** Diversity dashboard, performance feedback loop, and client context panel integrated into the workspace.

**Prerequisites:** Phase 1, Phase 2 (for AI features). Maya Phase 2 (diversity scoring) must be done in DAI.

### 5A. Diversity Dashboard

```
src/app/[clientCode]/diversity/
├── page.tsx                    -- Diversity dashboard page
```

```
src/components/
├── intelligence/
│   ├── DiversityDashboard.tsx      -- Main dashboard
│   ├── FormatAngleHeatMap.tsx      -- 17x15 grid with color intensity
│   ├── DistributionChart.tsx       -- Bar chart (format or angle)
│   ├── DiversityScore.tsx          -- Score gauge (0-100)
│   ├── GapRecommendations.tsx      -- "Try these combos" cards
│   └── ConcentrationWarnings.tsx   -- Alert banners
```

**Data source:** DAI API wrapping `get_creative_diversity_score()` and `get_creative_audit()` tools.

**Heat map:**
- 17 formats (rows) x 15 angles (columns)
- Cell color: white (untested), light blue (1-2 ads), medium (3-5), dark (6+)
- Cell tooltip: # of ads, spend, avg performance grade
- Click cell: shows list of briefs/ads with that combo
- Highlighted cells: recommended gaps

**Dashboard widgets:**
- Overall diversity score (gauge, 0-100)
- Format distribution (horizontal bar chart, by spend)
- Angle distribution (horizontal bar chart, by spend)
- Concentration warnings (red banners for >60% concentration)
- Gap recommendations (3-5 cards: "Try F17 x A01: Two-Person + Problem/Solution")
- "Generate concepts for gaps" button > opens concept generation flow with pre-selected coordinates

### 5B. Performance Feedback Loop

```
src/components/
├── intelligence/
│   ├── BriefPerformancePanel.tsx    -- Shows on brief editor when linked to ad
│   ├── LinkAdDialog.tsx             -- Search and link Meta ad ID
│   └── PerformanceBadge.tsx         -- A-F grade badge on brief cards
```

**Link briefs to ads:**
- In brief metadata sidebar: "Link to Ad" button
- Search dialog queries BMAD `creatives` table by name, id
- Manual link: paste ad ID
- Auto-suggest: match brief title/concept to creative names (fuzzy)
- Once linked: `brief_tracking` row created

**Performance display:**
- Brief cards in list show performance grade badge (A-F) if linked
- Brief editor shows performance panel: hook/watch/click/convert scores, composite grade
- "What worked" section: auto-generated from performance data
- Feed into concept generation: "This brief's F01 x A14 combo scored B+. Similar combos to try: ..."

### 5C. Client Context Panel

```
src/components/
├── intelligence/
│   ├── ClientContextPanel.tsx   -- Drawer/panel accessible from any brief
│   ├── BrandGuidelines.tsx      -- Rendered markdown from client docs
│   ├── RecentLearnings.tsx      -- Latest learnings for this client
│   └── TopPerformers.tsx        -- Top performing ads for context
```

**Data sources:**
- Brand guidelines: BMAD repo client docs (loaded at build time or from Supabase)
- Learnings: BMAD `learnings` table, filtered by client
- Top performers: BMAD `creatives` table, ordered by performance score

**Accessible from:**
- Brief editor: button in toolbar "Client Context"
- Brief list: button per client section
- Concept generation: always visible during discovery

### 5D. AI Suggestions as Tracked Changes

Tiptap extension for suggestion marks:

```
src/components/editor/extensions/
├── suggestion-mark.ts      -- Custom mark: green highlight (add) / red strikethrough (delete)
```

- Maya can return suggestions in structured format: `[{type: 'replace', from, to, newText, reason}]`
- Rendered as tracked changes in the editor
- Floating popover on suggestion: reason + Accept/Reject buttons
- "Accept All" / "Reject All" toolbar buttons when suggestions present
- Accepted: suggestion applied, mark removed. Rejected: original text restored.

### 5E. Acceptance Criteria

- [ ] Diversity dashboard shows heat map, scores, charts for any client
- [ ] Gap recommendations link to concept generation with pre-selected coordinates
- [ ] Can link a brief to a Meta ad ID
- [ ] Performance grade displays on brief cards and editor
- [ ] Client context panel shows brand guidelines, learnings, top performers
- [ ] AI suggestions render as tracked changes in editor
- [ ] Accept/reject suggestions works per-suggestion and in bulk

---

## Phase 6: Production & Polish

**Goal:** Export, assignment tracking, kanban view, client access, and mobile responsiveness.

**Prerequisites:** Phases 1-4 complete.

### 6A. Export

```
src/app/api/export/
├── notion/route.ts       -- Create/update Notion page from brief
├── pdf/route.ts          -- Generate PDF from brief content
└── markdown/route.ts     -- Export as markdown
```

**Notion export:**
- Uses @notionhq/client (same as BMAD dashboard)
- Creates page in client's Notion workspace with brief content
- Updates existing page if brief_code already exists
- Maps brief sections to Notion blocks (headings, paragraphs, tables, callouts)

**Google Docs export:**
- Uses Google Docs API (carry over from Brief Studio)
- Creates formatted doc with brief content
- Returns shareable link

**PDF export:**
- Server-side HTML-to-PDF (e.g., Puppeteer or @react-pdf/renderer)
- Styled template matching workspace design
- Downloadable from brief editor

**Copy as Markdown:**
- Client-side: convert Tiptap JSON to markdown string
- Copy to clipboard with notification

**Send to Slack:**
- Posts brief summary (title, client, format, angle, hooks) to chosen Slack channel
- Via DAI's Slack bot token
- Includes link back to workspace editor

### 6B. Assignment & Tracking

```
src/app/[clientCode]/production/
├── page.tsx              -- Kanban production view
```

```
src/components/
├── production/
│   ├── KanbanBoard.tsx       -- Drag-and-drop columns
│   ├── KanbanCard.tsx        -- Brief card in kanban
│   ├── AssignmentDialog.tsx  -- Assign creator/editor
│   └── DueDatePicker.tsx     -- Calendar picker
```

**Kanban columns:**
- Approved | Assigned | In Production | Delivered | Reviewed
- Drag cards between columns (updates brief status)
- Filter by assignee
- Cards show: title, format badge, assignee avatar, due date, days remaining

**Assignment:**
- Assign creator (from workspace_users with role=creator)
- Assign editor (from workspace_users with role=creator)
- Due date with calendar picker
- Slack notification to assignee when assigned

### 6C. Client-Facing View

```
src/app/share/[token]/
├── page.tsx              -- Public/semi-public brief view
```

- Shareable link with auth token (or Supabase Auth for client users)
- Read-only brief view (no editing, no AI)
- Can add comments
- Shows only approved briefs for the client
- Clean, branded layout (no workspace chrome)

### 6D. Mobile Responsive

- Sidebar collapses to hamburger menu
- Editor toolbar becomes floating bottom bar
- Brief list switches to single-column card view
- Chat sidebar becomes full-screen overlay
- Touch-friendly: larger tap targets, swipe gestures

### 6E. Acceptance Criteria

- [ ] Export to Notion creates/updates page correctly
- [ ] Export to PDF generates clean, styled document
- [ ] Copy as Markdown works
- [ ] Send to Slack posts summary with link
- [ ] Kanban board shows briefs in correct columns
- [ ] Can drag cards between kanban columns
- [ ] Assignment with Slack notification works
- [ ] Due dates display with "days remaining" on cards
- [ ] Client share link works (read-only, comments only)
- [ ] Mobile layout works for all major views
- [ ] No horizontal scroll on mobile

---

## Phase Dependencies

```
Phase 1 (Workspace Shell + Editor) ──────┬──> Phase 2 (Maya Integration)
                                         ├──> Phase 3 (Collaboration)
                                         └──> Phase 4 (QC Workflow) ──> needs Phase 2 for AI pre-check
                                                                     └──> Phase 6 (Production)
Phase 2 ──> Phase 5 (Creative Intelligence)

Parallelizable: Phase 2, 3, 4 can all start after Phase 1
Phase 5 needs Phase 2
Phase 6 needs Phase 4 (for status pipeline)
```

**Recommended order:** 1 → 2 + 3 (parallel) → 4 → 5 → 6

---

## Key Files Reference

### From BMAD (reusable patterns/data):
- Brief templates: `pma/global/video-brief-template.md`, `pma/global/static-brief-template.md`
- Client docs: `pma/clients/{code}/` (brand-guidelines, products, dos-and-donts, etc.)
- Agent prompts: `pma/agents/creative-strategist.md` (Marco), `pma/agents/creative-qa.md` (Quinn)
- Brief Studio components: `pma/dashboard/src/components/brief-studio/` (DialWizard, ConceptCards patterns)
- Supabase types: `pma/dashboard/src/lib/supabase.ts`
- Design system: CSS variables in `pma/dashboard/src/styles/globals.css`

### From DAI (backend integration):
- Agent runner: `src/agents/runner.ts` — `runAgent()` function to wrap
- Tool registry: `src/agents/tool-registry.ts` — Maya's tools
- Creative tools: `src/agents/tools/creative-tools.ts` — diversity score, audit
- Maya definition: `agents/maya/` (PERSONA.md, INSTRUCTIONS.md, FORMAT-REGISTRY.md, CREATIVE-METHODOLOGY.md)
- Maya client context: `agents/maya/clients/` (NP.md, LA.md, PL.md, MEOW.md)
- Profiles: `src/agents/profiles/index.ts` — creative_strategist profile

### Format/Angle codes:
- Full registry: `agents/maya/FORMAT-REGISTRY.md`
- F01-F17 (16 formats), A01-A15 (15 angles), 8 style modifiers, 6 hook types, 3 funnel stages
