"""Audit the animation library: does every clip move the way its name says?

    npm run library:audit          (also runs after npm run library)

Names come from filenames and catalogue matches, and they mislead: the user's "Carrying" was Mixamo's
"Carrying Someone Idle" (a standing pose), their "Talking" was "Talking While Seated". This checks the words of each
clip's NAME (what you pick it by) against the motion facts the library build measured (manifest features: gait,
posture, hips height, travel, airtime), and writes workspace/library/audit.json:
    {"clips": {id: {"name", "description", "problems": [{"rule", "says", "motion"}...]}}, "counts": {...}}
The app shows the problems on the clip's card, and the game export refuses a clip whose motion contradicts its game
name (tools/game_export.ts checkClip). Rules are deliberately narrow: each flags a hard contradiction, not taste.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'workspace', 'library')

WALK = re.compile(r'\b(walk|walking|run|running|jog|jogging|sprint|sprinting|march|marching|strafe|limp|limping|stroll)\b', re.I)
NOT_WALK = re.compile(r'\b(idle|stop|stopping|start|starting|to idle|turn|turning|pivot|180|90|in place|land|landing|'
                      r'jump|stand|standing up|sit|sitting|lean)\b', re.I)
SIT = re.compile(r'\b(sit|sits|sitting|seated|chair|bench|stool|kneel|kneeling|crouch|crouching|squat|lying|laying|lie|'
                 r'prone|sleep|sleeping|crawl|crawling|floor|ground|dead|death|dying|knocked|fall|falling|pushup|push up|'
                 r'situp|sit up|plank|swim|swimming|getting up|get up|stand up|standing up|bed|couch|on knees|praying|'
                 r'drunk|tied|breakdance|flair|planche|hang|hanging|climb|climbing|ledge|wall|slip|slipping|trip|tripping|'
                 r'stumble|stumbling|tackle|slide|sliding|backslide|roll|rolling|knockdown|knocked|swing|swinging|'
                 r'victim|takedown|wrestl\w*|grapple|pinned|fallen|zombie|mutant|crippled|injured|stunned|faint|fainting)\b', re.I)
DIE = re.compile(r'\b(death|dying|dies|die|killed|knocked out|knockout)\b', re.I)
JUMP = re.compile(r'\b(jump|jumping|leap|hopping|vault|backflip|flip|frontflip)\b|(?<!hip )\bhop\b', re.I)
JUMP_NOT = re.compile(r'\b(jacks|hip hop|to jump|jump start|jump attack)\b', re.I)
STANDING_WORDS = re.compile(r'\b(standing|stand|idle)\b', re.I)


def problems(c):
    f = c.get('features') or {}
    if not f or c.get('category') == 'pose':
        return []
    name = str(c.get('name') or '')
    context = name + ' ' + str(c.get('description') or '')
    gait = f.get('gait') or {}
    post = f.get('posture') or {}
    hips = f.get('hipsHeight') or {}
    rest_h = (c.get('rest') or {}).get('hipsHeight') if isinstance(c.get('rest'), dict) else None
    stand_h = rest_h or 0.95          # Mixamo Y Bot's hips stand ~0.95-0.98 m
    steps = float(gait.get('steps') or 0)
    score = float(gait.get('score') or 0)
    out = []
    # a walk that doesn't step: no alternating strides and no travel
    if WALK.search(name) and not NOT_WALK.search(name) and steps < 1 and score < 0.4 and float(f.get('travel') or 0) < 0.3:
        out.append({'rule': 'walks?', 'says': WALK.search(name).group(0),
                    'motion': 'the feet never step (gait %.2f, %d steps, travel %.2f m)' % (score, steps, float(f.get('travel') or 0))})
    # seated / lying / crouched motion under a name that doesn't say so
    low = float(post.get('thighsFlatFrac') or 0) > 0.6 or float(post.get('lyingFrac') or 0) > 0.5 or \
        (hips.get('mean') is not None and float(hips['mean']) < 0.68 * stand_h and float(post.get('lowFrac') or 0) > 0.5)
    if low and not SIT.search(context) and not DIE.search(context):
        what = 'lying' if float(post.get('lyingFrac') or 0) > 0.5 else 'seated or crouched'
        out.append({'rule': 'standing?', 'says': name,
                    'motion': '%s most of the clip (hips %.2f m, thighs level %.0f%%, lying %.0f%%)' % (
                        what, float(hips.get('mean') or 0), 100 * float(post.get('thighsFlatFrac') or 0), 100 * float(post.get('lyingFrac') or 0))})
    # an "idle" / "standing" clip that walks off
    if STANDING_WORDS.search(name) and not WALK.search(name) and steps >= 3 and score > 0.7 and float(f.get('travel') or 0) > 1.0:
        out.append({'rule': 'stands?', 'says': STANDING_WORDS.search(name).group(0),
                    'motion': 'it walks %.1f m in %d steps' % (float(f.get('travel') or 0), steps)})
    # a death that never goes down
    if DIE.search(name) and not f.get('endsLow') and float(hips.get('end') or 1) > 0.6 * stand_h:
        out.append({'rule': 'dies?', 'says': DIE.search(name).group(0),
                    'motion': 'it ends standing (hips %.2f m at the end)' % float(hips.get('end') or 0)})
    # a jump that never leaves the ground
    if JUMP.search(name) and not JUMP_NOT.search(name) and not f.get('airborneFrames') and float(hips.get('max') or 0) - float(hips.get('start') or 0) < 0.12:
        out.append({'rule': 'jumps?', 'says': JUMP.search(name).group(0),
                    'motion': 'the feet never leave the ground and the hips rise %.2f m' % (float(hips.get('max') or 0) - float(hips.get('start') or 0))})
    return out


def main():
    manifest = json.load(open(os.path.join(LIB, 'manifest.json')))
    report = {}
    counts = {}
    for c in manifest['clips']:
        p = problems(c)
        if p:
            report[c['id']] = {'name': c.get('name'), 'description': c.get('description'), 'source': c.get('source'), 'problems': p}
            for x in p:
                counts[x['rule']] = counts.get(x['rule'], 0) + 1
    out = {'clips': report, 'counts': counts, 'checked': len(manifest['clips'])}
    with open(os.path.join(LIB, 'audit.json'), 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    if '--quiet' not in sys.argv:
        for i, r in sorted(report.items(), key=lambda kv: (kv[1]['source'] != 'mixamo', kv[1]['name'] or '')):
            for x in r['problems']:
                print('%s  %-30s %-9s %s  (%s)' % (i, (r['name'] or '')[:30], x['rule'], x['motion'], (r['description'] or '')[:60]))
    print('library audit: %d of %d clips flagged %s -> %s' % (len(report), len(manifest['clips']), counts, os.path.join(LIB, 'audit.json')))


if __name__ == '__main__':
    main()
