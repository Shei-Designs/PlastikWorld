package com.sheidesigns.plastikworld

import android.content.res.Configuration
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

// PlastikCAD's MainActivity, lifted: the same window treatment on the same tablet.
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * The window is edge to edge, so the webview is kept inside the system bars and the
   * display cutout by margins; the window background (the app's own panel colour, see
   * themes.xml) shows behind the bars, with the clock drawn dark or light to suit.
   */
  override fun onWebViewCreate(webView: WebView) {
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    WindowCompat.getInsetsController(window, webView).isAppearanceLightStatusBars = !night
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
        params.setMargins(bars.left, bars.top, bars.right, bars.bottom)
        view.layoutParams = params
      }
      WindowInsetsCompat.CONSUMED
    }
  }
}
