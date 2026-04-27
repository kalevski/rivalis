'use client'

import { useEffect, useRef } from 'react'
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import bash from 'highlight.js/lib/languages/bash'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('bash', bash)

type Props = {
    code: string
    language?: 'typescript' | 'javascript' | 'bash'
}

const LABELS: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    bash: 'Bash'
}

export function CodeBlock({ code, language = 'typescript' }: Props) {
    const ref = useRef<HTMLElement>(null)

    useEffect(() => {
        if (!ref.current) return
        const result = hljs.highlight(code, { language })
        ref.current.innerHTML = result.value
    }, [code, language])

    return (
        <div className="code-block">
            <div className="code-block__header">
                <span className="code-block__lang">{LABELS[language]}</span>
            </div>
            <pre className="code-block__pre">
                <code ref={ref} className={`language-${language} code-block__code`} />
            </pre>
        </div>
    )
}
