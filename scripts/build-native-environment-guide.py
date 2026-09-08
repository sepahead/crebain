#!/usr/bin/env python3
"""Build the reviewed native environment math guide and its vector diagram.

Requires reportlab, pypdf, rsvg-convert, and embeddable Arial fonts.
The Markdown document remains the owning implementation contract.
"""
from pathlib import Path
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader, PdfWriter
import hashlib, subprocess, tempfile, os
root = Path(__file__).resolve().parents[1]
temporary = tempfile.TemporaryDirectory(prefix='crebain-math-guide-')
custody = Path(temporary.name)
font_dir = Path(os.environ.get('CREBAIN_PDF_FONT_DIR', '/System/Library/Fonts/Supplemental'))
font = str(font_dir / 'Arial.ttf')
bold = str(font_dir / 'Arial Bold.ttf')
pdfmetrics.registerFont(TTFont('Guide',font));pdfmetrics.registerFont(TTFont('GuideBold',bold))
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleGuide',fontName='GuideBold',fontSize=26,leading=31,spaceAfter=18,textColor=colors.HexColor('#172b3a')))
styles.add(ParagraphStyle(name='HeadingGuide',fontName='GuideBold',fontSize=17,leading=22,spaceBefore=16,spaceAfter=10,textColor=colors.HexColor('#315c67')))
styles.add(ParagraphStyle(name='BodyGuide',fontName='Guide',fontSize=11.4,leading=16.8,spaceAfter=10))
styles.add(ParagraphStyle(name='SmallGuide',fontName='Guide',fontSize=9,leading=13,spaceAfter=8,textColor=colors.HexColor('#385361')))
styles.add(ParagraphStyle(name='EquationGuide',fontName='Guide',fontSize=13.4,leading=22,spaceBefore=8,spaceAfter=12,backColor=colors.HexColor('#e9f1f3'),borderPadding=10))
flow=[]
def p(t):flow.append(Paragraph(t,styles['BodyGuide']))
def h(t):flow.append(Paragraph(t,styles['HeadingGuide']))
def eq(t):flow.append(Paragraph(t,styles['EquationGuide']))
def title(t,sub):flow.extend([Paragraph(t,styles['TitleGuide']),Paragraph(sub,styles['SmallGuide'])])
def page():flow.append(PageBreak())

title('A city, explicit time,<br/>and actual observations','CREBAIN native environment | Source component guide | September 8, 2026')
p('CREBAIN advances its existing Rapier drone dynamics. One authored metric scene supplies building colliders, meshes, Gaussian surfaces, acoustic obstruction, and thermal visibility.')
p('The CPU owns physical state, controller memory, rotor response, acoustic history, and temperature. A private Node and Chromium process owns actual RGB and thermal pixel rendering.')
h('What one step means')
eq('t<sub>k</sub> = k / 120 seconds; &nbsp; Δt = 1 / 120 seconds')
p('The integer k is the completed physics tick. The next scheduled action applies before that tick. Display reads and wall-clock delays cannot advance simulation time.')
p('Three ticks span 25 milliseconds. Six ticks span 50 milliseconds. These are exact interface durations; the integrator uses the existing floating-point time step.')
h('Command and response are different')
p('A motor command is a named fraction from 0 to 1. An attitude command sets roll and pitch in radians, yaw rate in radians per second, and altitude in meters. The controller retains its clamps, mixer, and saturation.')
p('The frame is positive Y upward, positive Z forward, and positive X right. It is not ENU or PushT. Commanded acceleration must never be claimed as delivered acceleration without a separate measured adapter.')
p('The default attitude controller failed a frozen three-second tracking campaign. A separate twelve-tick free-rotation probe observed no Euler gyroscopic evolution in its inspected configuration. The one-second city export does not qualify tracking or physical fidelity.')
h('Output and reference stay separate')
p('Accepted batches bind actual pressure, RGB, and thermal arrays. Privileged CPU truth is a separate field. A predictor must not gain checkpoint or future-label access through an observation interface.')
p('This component is not physical calibration, installed desktop qualification, a real-vehicle controller, or a completed NCP or Prisoma experiment integration.')

page();title('Heat: from rotor power<br/>to a thermal pixel','Declared lumped gray-surface model | Units and worked examples')
p('For rotor r, torque τ<sub>r</sub> is measured in newton-meters. Angular speed ω<sub>r</sub> is measured in radians per second. Actual rotor state supplies mechanical power P<sub>m</sub> in watts.')
eq('P<sub>m</sub> = Σ<sub>r</sub> |τ<sub>r</sub> ω<sub>r</sub>|<br/>P<sub>e</sub> = P<sub>m</sub> / η &nbsp;&nbsp; P<sub>h</sub> = P<sub>m</sub> (1/η - 1)')
p('Motor efficiency η is dimensionless, with 0 &lt; η ≤ 1. Electrical input P<sub>e</sub> and heat input P<sub>h</sub> are declared constant-efficiency quantities. The normalized battery value is not their energy source.')
p('<b>Example:</b> 70 W of mechanical power at efficiency 0.7 requires 100 W of modeled electrical input and gives 30 W of modeled heat.')
p('Temperature T is in kelvin. Ambient temperature is T<sub>a</sub>. Heat capacity C is in J/K, effective area A in m², and convection coefficient h in W/(m² K). Emissivity ε is dimensionless.')
eq('C (T<sub>k+1</sub> - T<sub>k</sub>) / Δt = P<sub>h</sub><br/>&nbsp; - h A (T<sub>k+1</sub> - T<sub>a</sub>)<br/>&nbsp; - ε σ A (T<sub>k+1</sub><super>4</super> - T<sub>a</sub><super>4</super>)')
p('The constant σ is 5.670374419 × 10<super>-8</super> W/(m² K<super>4</super>). The next temperature appears in the loss terms: this is backward Euler.')
p('The residual derivative C/Δt + hA + 4εσAT³ is positive. A bounded bracket and 64 bisection iterations therefore select one admitted solution. An out-of-range solution fails the transition.')
p('<b>Example:</b> With no heat loss, 30 W and C = 100 J/K increase temperature by 0.0025 K in one tick. Positive losses reduce this increase above ambient.')

page();title('Radiance is not temperature','Actual floating-point rendering | No spectral camera calibration')
eq('L = (σ / π) [ε T<super>4</super> + (1 - ε) T<sub>a</sub><super>4</super>]')
p('The output L is diffuse bolometric radiance in W/(m² sr). A steradian, sr, measures solid angle. The reflected term assumes uniform ambient radiation.')
p('<b>Ambient example:</b> When T = T<sub>a</sub> = 293.15 K, L is about 133.2973 W/(m² sr), regardless of emissivity.')
p('<b>Warm-surface example:</b> T = 400 K, ε = 0.9, and the same ambient temperature give about 429.1870 W/(m² sr). Independent arithmetic checks verify these actual rendered values.')
h('What the image contains')
p('An actual float render target resolves visible surfaces against the shared scene geometry. Each thermal pixel stores one float32 little-endian radiance value. An opaque wall can hide a warm drone.')
p('The RGB path separately awaits actual Spark and Three.js rendering. It copies RGBA8 sRGB bytes before another capture can reuse the buffer. Rows begin at the bottom-left.')
h('What this model does not contain')
p('Bolometric means all wavelengths. This is not an 8-14 micrometer camera, a detector spectral response, or a temperature estimate. No false-color RGB output is presented as a physical measurement.')
p('Thermal area, heat capacity, emissivity, and efficiency are declared effective parameters. They are not inferred from the visible drone mesh. The model does not claim measured drone fidelity or a globally closed scene energy balance.')
h('A decisive image control')
p('Setting Gaussian opacity to zero versus one must change actual RGB pixels. Mesh rendering alone cannot satisfy the Gaussian contribution claim. Camera order, cold contexts, and repeated moving-drone captures are separate controls.')

page();title('Pressure: phase, delay,<br/>and an honest range limit','Explicit acoustic forward model | 16,000 samples per second')
eq('[ floor((k - 1) f<sub>s</sub> / 120), floor(k f<sub>s</sub> / 120) )<br/>f<sub>s</sub> = 16,000 Hz')
p('The first three complete intervals contain 133, 133, and 134 samples. CPU advances first; completed pose and rotor speed remain constant within that audio block. This is a declared approximation.')
eq('f<sub>b</sub> = 2 n / 60 Hz<br/>q(φ) = sin φ + 0.3 sin(2φ) + 0.1 sin(3φ)')
p('For a two-bladed rotor, n is revolutions per minute and f<sub>b</sub> is blade-passage frequency. At 6,000 RPM the fundamental is 200 Hz. Phase φ advances at that frequency. Amplitude scales with (n/15,000)² and the declared reference pressure.')
eq('delay = max(d, d<sub>0</sub>) / c seconds<br/>gain = d<sub>0</sub> / max(d, d<sub>0</sub>) × obstruction factor')
p('Distance d and reference distance d<sub>0</sub> are in meters. Sound speed c is in m/s. Fractional delays interpolate retained waveform samples. At d = 34.3 m and c = 343 m/s, delay is 0.1 seconds, or 1,600 samples.')
p('That example needs a maximum range of at least 34.3 m. The default 32 m profile omits the source. Noise still produces valid microphone samples; valid output does not imply visibility of every intervention.')
p('The selected 256-drone challenge changed dynamics, RGB, and thermal output. Its selected drone stayed more than 44 m from either microphone, so the intervention did not change pressure. The failed all-modality assertion is retained.')
p('The model retains phases, delay rings, noise generator state, and sample index. It omits echoes, diffraction, calibrated directivity, and moving-source retarded geometry. Cloned noise is shared randomness, not independent replication.')

page();title('A checkpoint is a bounded<br/>causal contract','Exact CPU reconstruction | Fresh static renderer | Independent branch lifetime')
p('A live owner-issued checkpoint requires a released observation lease, no pending operation, and a tick at which every camera was due. If camera periods have no common positive tick within 7,200 ticks, that checkpoint capability is unavailable.')
p('The complete CPU checkpoint includes dynamics, controller memory, motors, battery, accepted future actions, acoustic history, noise, and temperature. The same actual transition reconstructs it from the bound initial state and action prefix.')
eq('S<sub>k</sub> = F(S<sub>k-1</sub>, u<sub>k</sub>)')
p('S is complete admitted CPU state. F is the existing transition. u contains the selected controls for that tick, including no replacement. Exact canonical state comparison guards replay acceptance.')
p('A child starts a fresh private static renderer and must reproduce the checkpoint’s current typed pixel digests. This does not clone hidden GPU state. Equal current images cannot prove all future images equal.')
p('Both experimental arms use fresh matched siblings. A warm parent is an additional diagnostic, not the sole causal control. Frozen same-action future outputs must remain exactly equal. Deliberately different action effects are allowed.')
p('Each child binds its parent checkpoint, accepted batch prefix, and action-history position. New owner and graphics generation identities make causal batch hashes different even when raw samples match. Audit JSON alone cannot recreate a live fork token.')
h('Failure and capacity')
p('Failed reconstruction retires only the candidate. Primary failure and cleanup failure remain separate. Constructing and unresolved generations still consume the four-owner family ceiling. A no-op retirement retry cannot erase an earlier unresolved CPU cleanup.')
p('The 128 MiB retained CPU budget is separate from one 64 MiB temporary reconstruction checkpoint. Camera staging reserves at most 32 MiB raw bytes. A CPU restore also reserves one extra temporary owner. Unresolved cleanup retains that slot and the 64 MiB checkpoint reservation, blocking another reconstruction. These are logical reservations, not total RSS or GPU-memory guarantees.')

page();title('One intervention,<br/>three observed responses','Private frozen force-ground campaign | Matched siblings and reversed order controls')
p('A parent stops at tick 24, or 0.2 seconds. Three fresh children reconstruct its complete CPU state and verify current pixels. Two receive baseline actions. The third receives a different target at tick 25.')
p('The intervention requests roll 0.02 rad, pitch 0.03 rad, absolute heading 0.04 rad, and altitude eight meters. At tick 61, the inherited level target applies. Each child stops at tick 84.')
eq('d<sub>k</sub> = 1,000 √[(Δx<sub>k</sub>)² + (Δy<sub>k</sub>)² + (Δz<sub>k</sub>)²] mm<br/>ΔT<sub>k</sub> = T<sub>B,k</sub> - T<sub>A1,k</sub> K<br/>e<sub>k</sub> = √[(1/N<sub>k</sub>) Σ<sub>j</sub> (p<sub>B,k,j</sub> - p<sub>A1,k,j</sub>)²] Pa')
p('The values Δx, Δy, and Δz are B minus A1 position components in meters. Multiplying by 1,000 converts meters to millimeters. T is temperature in kelvin. The value p is mic-a pressure in pascals. N is the current block length: 133 or 134 samples. The index j covers exactly that block; k is the completed physics tick.')
p('Position distance d reaches 13.337742 mm in this selected continuation. The temperature difference is negative: the intervention arm is slightly cooler. Pressure difference e summarizes paired waveform differences; it is not sensor error or a statistical significance test.')
p('Both creation and advancement orders passed, totaling 408 coupled advances. Matched siblings and corresponding reversed-order branches retained exact outputs and final CPU states. Every owner retired with zero leases and family reservations.')
h('Resolution changes the observation')
eq('f<sub>y</sub> = H / [2 tan(θ / 2)] pixels')
p('H is image height in pixels; θ is vertical field of view. At H = 48 and θ = 60 degrees, f<sub>y</sub> is about 41.57 pixels. A 0.05-meter feature at 5.2 meters spans about 0.40 pixels before orientation effects.')
p('The original 64 × 48 campaign failed: its thin drone mesh missed every thermal pixel center at tick 36. A separately frozen 256 × 192 arm passed the original criteria. A CPU/GPU edge-coordinate diagnostic still failed at two pixels; separate interior and exterior controls passed.')
p('The public series is a derived summary of the private campaign, not a public replay package. Shared noise and order repeats are not independent replicates. These results do not qualify physical fidelity, NCP transport, or a complete Prisoma experiment.')

source_digest=hashlib.sha256((root/'docs/NATIVE_ENVIRONMENT.md').read_bytes()).hexdigest()
def footer(canvas,doc):
 canvas.setFont('Guide',8);canvas.setFillColor(colors.HexColor('#617884'));canvas.drawString(42,27,'CREBAIN | Scoped simulation component | '+source_digest[:16]);canvas.drawRightString(A4[0]-42,27,str(doc.page))
body_path=custody/'math-guide-body.pdf'
SimpleDocTemplate(str(body_path),pagesize=A4,rightMargin=44,leftMargin=44,topMargin=42,bottomMargin=46,title='CREBAIN Native Environment: Math and Ownership',author='CREBAIN').build(flow,onFirstPage=footer,onLaterPages=footer)
subprocess.run(['rsvg-convert','--format','pdf','--width','277mm','--height','191mm','--keep-aspect-ratio','--page-width','297mm','--page-height','210mm','--left','10mm','--top','9mm',str(root/'assets/diagrams/native-environment.svg'),'-o',str(custody/'math-guide-diagram.pdf')],check=True)
writer=PdfWriter()
subprocess.run(['rsvg-convert','--format','pdf','--width','277mm','--height','191mm','--keep-aspect-ratio','--page-width','297mm','--page-height','210mm','--left','10mm','--top','9mm',str(root/'assets/diagrams/force-ground-coupled.svg'),'-o',str(custody/'math-guide-coupled.pdf')],check=True)
for path in [body_path,custody/'math-guide-diagram.pdf',custody/'math-guide-coupled.pdf']:
 reader=PdfReader(path)
 for page in reader.pages:writer.add_page(page)
writer.add_metadata({'/Title':'CREBAIN Native Environment: Math and Ownership','/Author':'CREBAIN','/Subject':'Explicit source-component models, actual observations, and bounded checkpoint claims'})
output=root/'output/pdf/native-environment-math.pdf'
output.parent.mkdir(parents=True, exist_ok=True)
with output.open('wb')as stream:writer.write(stream)
temporary.cleanup()
print(str(output),len(writer.pages),'pages')
