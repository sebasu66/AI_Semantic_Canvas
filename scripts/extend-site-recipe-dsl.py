from pathlib import Path
p = Path('apps/bridge/src/semantic/site-recipes.ts')
s = p.read_text(encoding='utf-8')
s = s.replace("export type RecipeValue = {\n  selector?: string;\n  attribute?: string;\n  fallback?: string;\n  maxLength?: number;\n};",
"export type RecipeValue = {\n  static?: string;\n  selector?: string;\n  attribute?: string;\n  property?: 'value' | 'textContent' | 'currentSrc' | 'poster';\n  fallback?: string;\n  maxLength?: number;\n};")
s = s.replace("  id: string;\n  type: string;\n  label: string;\n  root?: string;",
"  id: string;\n  type: string;\n  label: string;\n  representation?: 'data' | 'live-region' | 'hybrid';\n  root?: string;", 1)
s = s.replace("  id: string;\n  type: string;\n  label: string;\n  title?: string;",
"  id: string;\n  type: string;\n  label: string;\n  representation?: 'data' | 'live-region' | 'hybrid';\n  regionSelector?: string;\n  title?: string;", 1)
s = s.replace("      if (!spec) return '';\n      const el = spec.selector ? scope.querySelector(spec.selector) : scope;\n      if (!el) return spec.fallback || '';\n      const raw = spec.attribute ? el.getAttribute(spec.attribute) : (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '');\n      return clean(raw, spec.maxLength || 240) || spec.fallback || '';",
"      if (!spec) return '';\n      if (spec.static) return clean(spec.static, spec.maxLength || 240);\n      const el = spec.selector ? scope.querySelector(spec.selector) : scope;\n      if (!el) return spec.fallback || '';\n      let raw = '';\n      if (spec.attribute) raw = el.getAttribute(spec.attribute) || '';\n      else if (spec.property && ['value','textContent','currentSrc','poster'].includes(spec.property)) raw = el[spec.property] || '';\n      else raw = el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '';\n      return clean(raw, spec.maxLength || 240) || spec.fallback || '';")
s = s.replace("        id: widget.id,\n        type: widget.type,\n        label: widget.label,",
"        id: widget.id,\n        type: widget.type,\n        label: widget.label,\n        representation: widget.representation || 'data',\n        ...(widget.representation === 'live-region' || widget.representation === 'hybrid' ? { regionSelector: widget.root || 'body' } : {}),")
p.write_text(s, encoding='utf-8')
print('recipe DSL extended')
