// Disegna l'icona dell'app (1024×1024) nel percorso passato come argomento.
import AppKit

let size: CGFloat = 1024
let inset: CGFloat = 100
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let shape = NSBezierPath(roundedRect: body, xRadius: 186, yRadius: 186)

NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
shadow.shadowBlurRadius = 28
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()
NSColor(calibratedRed: 0.36, green: 0.30, blue: 0.93, alpha: 1).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

NSGradient(colors: [
    NSColor(calibratedRed: 0.55, green: 0.47, blue: 1.00, alpha: 1),
    NSColor(calibratedRed: 0.30, green: 0.24, blue: 0.86, alpha: 1),
])!.draw(in: shape, angle: -90)

let config = NSImage.SymbolConfiguration(pointSize: 470, weight: .medium)
    .applying(NSImage.SymbolConfiguration(paletteColors: [NSColor(calibratedRed: 0.40, green: 0.33, blue: 0.93, alpha: 1), .white]))
if let symbol = NSImage(systemSymbolName: "captions.bubble.fill", accessibilityDescription: nil)?
    .withSymbolConfiguration(config) {
    let s = symbol.size
    symbol.draw(in: NSRect(x: (size - s.width) / 2, y: (size - s.height) / 2 - 8, width: s.width, height: s.height))
}

image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
