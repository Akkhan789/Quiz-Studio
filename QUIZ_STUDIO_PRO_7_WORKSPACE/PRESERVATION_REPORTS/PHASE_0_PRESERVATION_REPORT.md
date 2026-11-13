# Phase 0 — Application Preservation & Integrity Report

## 1. Preservation Status
- **Phase:** Phase 0 (Preservation, Source Backup & Read-Only Architecture Audit)
- **Primary Archive Integrity:** **VERIFIED (Byte-for-Byte Match)**
- **Reference Archive Integrity:** **VERIFIED (Byte-for-Byte Match)**
- **Working Copy Integrity:** **VERIFIED (Byte-for-Byte Match to Primary)**
- **Source Code Modifications Made:** **0 files modified** in `ORIGINAL_ARCHIVES/`, `PRESERVED_PRIMARY_SOURCE/`, `PRESERVED_REFERENCE_SOURCE/`, `WORKING_SOURCE/`, or the container root application.

## 2. Preserved Archives (`QUIZ_STUDIO_PRO_7_WORKSPACE/ORIGINAL_ARCHIVES/`)

| Role | Requested Archive Name | Source Path in Workspace | Exact Size (bytes) | SHA-256 |
| :--- | :--- | :--- | ---: | :--- |
| Primary Application (ZIP A) | `quiz-studio-pro (7).zip` | `public/assets/aistudio/quiz-studio-pro__7__fb825d50.zip` | 14,097,579 | `fb825d50bfb6f54fea2f0787e3a42fd1694a9223ef67d85e4fb8d0188ccf4415` |
| Secondary Reference (ZIP B) | `quiz-studio-pro (1) - compact-source-reference.zip` | `public/assets/aistudio/quiz-studio-pro__1__-_compact-source-reference_4a879cd1.zip` | 869,469 | `4a879cd1400125e1f7eec7247e3c966696e4d895f8c860f8a81460608a1bc91c` |

## 3. Workspace Layout & Extraction Verification

```text
QUIZ_STUDIO_PRO_7_WORKSPACE/
├── ORIGINAL_ARCHIVES/
│   ├── quiz-studio-pro (7).zip
│   └── quiz-studio-pro (1) - compact-source-reference.zip
├── PRESERVED_PRIMARY_SOURCE/       (83 files, 41 dirs, untouched)
├── PRESERVED_REFERENCE_SOURCE/     (77 files, 31 dirs, untouched)
├── WORKING_SOURCE/                 (83 files, separate copy for baseline checks & future phases)
├── PRESERVATION_REPORTS/
│   ├── PHASE_0_PRESERVATION_REPORT.md
│   ├── FILE_INVENTORY.md
│   ├── CHECKSUM_MANIFEST.md
│   └── BASELINE_REGRESSION.md
└── PROJECT_MEMORY/
    └── PROJECT_ARCHITECTURE_MEMORY.md
```

### Byte-for-Byte Extraction Audit

| Target | ZIP Total Entries | ZIP Files | ZIP Dirs | Extracted Files | Extracted Bytes | Missing | Extra | Mismatched |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `PRESERVED_PRIMARY_SOURCE/` | 124 | 83 | 41 | 83 | 14,078,555 | 0 | 0 | 0 |
| `WORKING_SOURCE/` | 124 | 83 | 41 | 83 | 14,078,555 | 0 | 0 | 0 |
| `PRESERVED_REFERENCE_SOURCE/` | 108 | 77 | 31 | 77 | 1,109,550 | 0 | 0 | 0 |

## 4. Hidden Files & Nested Archives Audit
- **Hidden dotfiles inside Primary ZIP:** `3` (`.env.example`, `.gitignore`, `app/.gitignore`)
- **Hidden dotfiles inside Reference ZIP:** `3` (`.env.example`, `.gitignore`, `app/.gitignore`)
- **Note on root `.gitignore` / `.env.example` / `debug.keystore`:** Neither ZIP contains `.gitignore`, `.env`, `.env.example`, or `debug.keystore`.
- **Nested archives & attachments preserved inside Primary (`public/assets/aistudio/`):**
  - `public/assets/aistudio/Quiz-Studio-Pro-main_12e8cd32.zip` (5,132,906 bytes, SHA-256 `12e8cd32f31c5582e1ac278a296a29add579340b5c65418afd7bec510e6eeb54`)
  - `public/assets/aistudio/quiz-studio-pro__1__-_compact-source-reference_4a879cd1.zip` (869,469 bytes, SHA-256 `4a879cd1400125e1f7eec7247e3c966696e4d895f8c860f8a81460608a1bc91c`)
  - `public/assets/aistudio/quiz-studio-pro__6__4c0aa953.zip` (6,593,428 bytes, SHA-256 `4c0aa953ed63900f8810edc1adba308343e299e4d95d03de80454e58b68eac3b`)
  - `public/assets/aistudio/Paste_November_12__2026_-_5_39PM_2b214df2` (40,624 bytes, SHA-256 `2b214df2f5cc73c7f2c92af1401cf83ac541297b04b3dc0beb548754a395671f`)
- **Nested archives inside Reference:** `0`

## 5. Companion Audit Reports
- Complete path/size/type inventory: `QUIZ_STUDIO_PRO_7_WORKSPACE/PRESERVATION_REPORTS/FILE_INVENTORY.md`
- Full SHA-256 manifest: `QUIZ_STUDIO_PRO_7_WORKSPACE/PRESERVATION_REPORTS/CHECKSUM_MANIFEST.md`
- Baseline feature & test verification: `QUIZ_STUDIO_PRO_7_WORKSPACE/PRESERVATION_REPORTS/BASELINE_REGRESSION.md`
- Persistent architecture memory: `QUIZ_STUDIO_PRO_7_WORKSPACE/PROJECT_MEMORY/PROJECT_ARCHITECTURE_MEMORY.md`
