import SwiftUI
import UIKit

@main
struct WatchlivoApp: App {
    @StateObject private var bridge = WatchlivoBridgeState()

    init() {
        UIApplication.shared.isIdleTimerDisabled = true
    }

    var body: some Scene {
        WindowGroup {
            WatchlivoRootView(bridge: bridge)
                .preferredColorScheme(.dark)
                .onOpenURL { incomingURL in
                    bridge.handleIncomingURL(incomingURL)
                }
        }
    }
}

private struct WatchlivoRootView: View {
    @ObservedObject var bridge: WatchlivoBridgeState
    @State private var pulse: Bool = false

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.047, blue: 0.082)
                .ignoresSafeArea(.all)

            WatchlivoWebView(bridge: bridge)
                .ignoresSafeArea(.all)

            if !bridge.isInitialLoadComplete && bridge.loadErrorMessage == nil {
                WatchlivoSplashOverlay(pulse: $pulse)
                    .transition(.opacity)
                    .zIndex(10)
            }

            if let errMsg = bridge.loadErrorMessage {
                WatchlivoErrorOverlay(
                    message: errMsg,
                    onRetry: { bridge.triggerReload() },
                    onGoHome: { bridge.openHome() }
                )
                .transition(.opacity)
                .zIndex(20)
            }
        }
        .animation(.easeOut(duration: 0.32), value: bridge.isInitialLoadComplete)
        .animation(.easeOut(duration: 0.22), value: bridge.loadErrorMessage)
        .task {
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            if !bridge.isInitialLoadComplete {
                bridge.isInitialLoadComplete = true
            }
        }
    }
}

private struct WatchlivoSplashOverlay: View {
    @Binding var pulse: Bool

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.071, green: 0.086, blue: 0.149),
                    Color(red: 0.027, green: 0.031, blue: 0.063)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea(.all)

            VStack(spacing: 22) {
                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [
                                    Color(red: 0.0, green: 0.96, blue: 0.83).opacity(0.28),
                                    Color(red: 0.66, green: 0.33, blue: 0.97).opacity(0.10),
                                    Color.clear
                                ],
                                center: .center,
                                startRadius: 12,
                                endRadius: 88
                            )
                        )
                        .frame(width: 176, height: 176)
                        .scaleEffect(pulse ? 1.09 : 0.94)

                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color(red: 0.085, green: 0.105, blue: 0.185),
                                    Color(red: 0.043, green: 0.051, blue: 0.098)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 104, height: 104)
                        .overlay(
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .stroke(
                                    LinearGradient(
                                        colors: [
                                            Color(red: 0.0, green: 0.96, blue: 0.83).opacity(0.50),
                                            Color(red: 0.66, green: 0.33, blue: 0.97).opacity(0.22)
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ),
                                    lineWidth: 1.5
                                )
                        )
                        .shadow(color: Color.black.opacity(0.55), radius: 24, x: 0, y: 12)

                    WatchlivoEmblem()
                        .frame(width: 68, height: 68)
                }

                VStack(spacing: 6) {
                    Text("WATCHLIVO")
                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                        .tracking(3.2)
                        .foregroundStyle(
                            LinearGradient(
                                colors: [
                                    Color.white,
                                    Color(red: 0.0, green: 0.96, blue: 0.83)
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )

                    Text("Birlikte Sinema • Canlı Odalar")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.58))
                }

                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: Color(red: 0.0, green: 0.96, blue: 0.83)))
                    .scaleEffect(1.05)
                    .padding(.top, 8)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

private struct WatchlivoEmblem: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            ZStack {
                Path { path in
                    path.move(to: CGPoint(x: w * 0.14, y: h * 0.31))
                    path.addLine(to: CGPoint(x: w * 0.31, y: h * 0.82))
                    path.addLine(to: CGPoint(x: w * 0.50, y: h * 0.46))
                    path.addLine(to: CGPoint(x: w * 0.69, y: h * 0.82))
                    path.addLine(to: CGPoint(x: w * 0.86, y: h * 0.31))
                }
                .stroke(
                    LinearGradient(
                        colors: [
                            Color(red: 0.0, green: 0.96, blue: 0.83),
                            Color(red: 0.22, green: 0.74, blue: 0.97),
                            Color(red: 0.66, green: 0.33, blue: 0.97)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    style: StrokeStyle(lineWidth: w * 0.125, lineCap: .round, lineJoin: .round)
                )

                Circle()
                    .fill(Color(red: 0.0, green: 0.96, blue: 0.83))
                    .frame(width: w * 0.13, height: w * 0.13)
                    .position(x: w * 0.50, y: h * 0.22)
            }
        }
    }
}

private struct WatchlivoErrorOverlay: View {
    let message: String
    let onRetry: () -> Void
    let onGoHome: () -> Void

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.047, blue: 0.082).opacity(0.96)
                .ignoresSafeArea(.all)

            VStack(spacing: 18) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundColor(Color(red: 0.0, green: 0.96, blue: 0.83))

                Text("Bağlantı Kurulamadı")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(.white)

                Text(message)
                    .font(.system(size: 14))
                    .foregroundColor(Color.white.opacity(0.72))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)

                HStack(spacing: 12) {
                    Button(action: onRetry) {
                        Label("Tekrar Dene", systemImage: "arrow.clockwise")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(Color(red: 0.02, green: 0.07, blue: 0.10))
                            .padding(.horizontal, 22)
                            .padding(.vertical, 12)
                            .background(Color(red: 0.0, green: 0.96, blue: 0.83))
                            .clipShape(Capsule())
                    }

                    Button(action: onGoHome) {
                        Text("Ana Sayfa")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 12)
                            .background(Color.white.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
                .padding(.top, 6)
            }
            .padding(28)
        }
    }
}
