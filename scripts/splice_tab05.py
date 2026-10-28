"""Splice the new tab 05 (schedule) fragment into command-tower.tsx,
replacing everything from the '════ 05' comment through '</main>'."""
import io

TOWER = '/home/z/my-project/src/components/backbone/command-tower.tsx'
FRAG = '/home/z/my-project/scripts/tower-tab05.fragment.txt'

src = io.open(TOWER, encoding='utf-8').read()
frag = io.open(FRAG, encoding='utf-8').read().rstrip('\n')

start = src.index('{/* ════ 05')
end = src.index('</main>', start)
# keep indentation of the closing tag line
end = src.rindex('        ', start, end)  # start of the '        </main>' line indent

new = src[:start] + frag + src[end:]
io.open(TOWER, 'w', encoding='utf-8').write(new)
print('spliced ok; old len', len(src), '→ new len', len(new))
