'use client'

import { Badge, Heading, Text, Card, CodeSnippet, Icon, CoolButton } from '@toolcase/react-components'

const SKILL_URL = 'https://rivalis.dev/SKILL.md'

const claudeCodeInstall = `# Install the Rivalis skill into Claude Code
mkdir -p ~/.claude/skills/rivalis
curl -fsSL ${SKILL_URL} -o ~/.claude/skills/rivalis/SKILL.md`

const cursorInstall = `# Drop the skill next to your repo so the agent picks it up
mkdir -p .cursor/rules
curl -fsSL ${SKILL_URL} -o .cursor/rules/rivalis.md`

const promptUsage = `Read the Rivalis skill at ${SKILL_URL}
and use it as the source of truth when you write or review code that
imports @rivalis/core or @rivalis/browser.`

export function SkillSection() {
    return (
        <section id="ai-skill" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">FOR AI CODING ASSISTANTS</Badge>
                    <Heading as="h2" gradient>
                        Teach your AI to write Rivalis.
                    </Heading>
                    <Text as="p" variant="muted">
                        Rivalis ships a single-file skill manifest at <code>{SKILL_URL}</code>. Load it into Claude Code, Cursor, or any agent with a custom-instructions slot, and the assistant will know the recipes, pitfalls, close codes, and security defaults — so the code it generates actually compiles and follows the framework rules. Same approach Phaser uses with its own AI skill files — load once, the assistant follows the rules.
                    </Text>
                    <div className="d-flex justify-content-center gap-2 flex-wrap mt-4">
                        <a href="/SKILL.md" target="_blank" rel="noopener noreferrer">
                            <CoolButton variant="primary" size="large">Open SKILL.md</CoolButton>
                        </a>
                        <a href="https://docs.claude.com/en/docs/claude-code/skills" target="_blank" rel="noopener noreferrer">
                            <CoolButton variant="primary" size="large">Claude skills docs</CoolButton>
                        </a>
                    </div>
                </div>

                <div className="row g-4 justify-content-center">
                    <div className="col-12 col-lg-4">
                        <Card>
                            <div className="px-3 py-3 h-100 d-flex flex-column">
                                <div className="mb-2">
                                    <Icon name={'robot' as never} />
                                </div>
                                <Heading as="h3">What it is</Heading>
                                <Text as="p" variant="muted" size="small">
                                    A YAML-fronted Markdown file describing when to use Rivalis, the minimal server &amp; client, the wire protocol, all four room recipes, the auth middleware pattern, close codes, and rate-limiting defaults — everything a coding agent needs in one fetch.
                                </Text>
                            </div>
                        </Card>
                    </div>

                    <div className="col-12 col-lg-4">
                        <Card>
                            <div className="px-3 py-3 h-100 d-flex flex-column">
                                <div className="mb-2">
                                    <Icon name={'magic' as never} />
                                </div>
                                <Heading as="h3">Why it helps</Heading>
                                <Text as="p" variant="muted" size="small">
                                    Without a skill, AI agents guess. They forget that <code>__</code>-prefixed topics are reserved, or that rooms must be defined before connections. The skill encodes those rules — your agent stops inventing APIs and starts shipping working code.
                                </Text>
                            </div>
                        </Card>
                    </div>

                    <div className="col-12 col-lg-4">
                        <Card>
                            <div className="px-3 py-3 h-100 d-flex flex-column">
                                <div className="mb-2">
                                    <Icon name={'arrow-down-circle' as never} />
                                </div>
                                <Heading as="h3">Always current</Heading>
                                <Text as="p" variant="muted" size="small">
                                    The file is served from the same domain as this page. Re-fetch it anytime to pull the latest recipes — or pin a copy into your repo if you want a frozen reference.
                                </Text>
                            </div>
                        </Card>
                    </div>
                </div>

                <div className="row g-4 justify-content-center mt-2">
                    <div className="col-12 col-lg-6">
                        <Card>
                            <div className="px-3 py-3">
                                <div className="d-flex align-items-center gap-2 mb-3">
                                    <Badge variant="info" pill size="sm">CLAUDE CODE</Badge>
                                    <Text as="span" variant="muted" size="small">Auto-loaded from <code>~/.claude/skills/</code></Text>
                                </div>
                                <CodeSnippet code={claudeCodeInstall} language="bash" />
                                <Text as="p" variant="muted" size="small" className="mt-3 mb-0">
                                    Once installed, Claude Code picks up the skill on its own — no config, no restart. Project-scoped install: drop it under <code>.claude/skills/rivalis/SKILL.md</code> at the repo root instead.
                                </Text>
                            </div>
                        </Card>
                    </div>

                    <div className="col-12 col-lg-6">
                        <Card>
                            <div className="px-3 py-3">
                                <div className="d-flex align-items-center gap-2 mb-3">
                                    <Badge variant="info" pill size="sm">CURSOR / WINDSURF</Badge>
                                    <Text as="span" variant="muted" size="small">Or any project-rules slot</Text>
                                </div>
                                <CodeSnippet code={cursorInstall} language="bash" />
                                <Text as="p" variant="muted" size="small" className="mt-3 mb-0">
                                    The format is plain Markdown — paste it into any agent that accepts custom rules, system prompts, or knowledge files.
                                </Text>
                            </div>
                        </Card>
                    </div>

                    <div className="col-12 col-lg-10">
                        <Card>
                            <div className="px-3 py-3">
                                <div className="d-flex align-items-center gap-2 mb-3">
                                    <Badge variant="warning" pill size="sm">ANY ASSISTANT</Badge>
                                    <Text as="span" variant="muted" size="small">Point it at the URL in a prompt</Text>
                                </div>
                                <CodeSnippet code={promptUsage} language="bash" />
                                <Text as="p" variant="muted" size="small" className="mt-3 mb-0">
                                    For chat UIs without a skills system (ChatGPT, Gemini, etc.), the simplest path is to ask the model to fetch the URL and treat it as the framework's reference. The file is small enough to paste inline if web-fetch is unavailable.
                                </Text>
                            </div>
                        </Card>
                    </div>
                </div>
            </div>
        </section>
    )
}
