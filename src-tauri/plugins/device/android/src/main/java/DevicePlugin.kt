// What the app runs on: whether a hardware keyboard is attached (a dock, a
// Bluetooth keyboard) and whether the on-screen keypad is showing, both read
// from the system (no permissions needed) and reported again the moment they
// change, so the page can switch between typing in place and the entry sheet
// without guessing. Also writes the documents the system pickers hand out, and
// asks Google Play services for the Drive authorization (Google takes no
// redirect URL from an Android app; its own sheet asks and hands back a token).
package com.sheidesigns.plastikworld.device

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.content.Context
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import android.view.InputDevice
import android.view.View
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

@InvokeArg
internal class CreateDocumentArgs {
  /** A document URI from `pickFolder` or an earlier `createDocument`. */
  lateinit var parent: String
  lateinit var name: String
  /** The document's type; `vnd.android.document/directory` makes a folder. */
  lateinit var mime: String
}

@InvokeArg
internal class MimeForArgs {
  lateinit var name: String
  lateinit var mime: String
}

@InvokeArg
internal class ExportArgs {
  /** Folder under the app's own folder in Downloads; empty for the app's folder itself. */
  lateinit var folder: String
  lateinit var name: String
  lateinit var mime: String
  /** A file holding the bytes, copied in and then deleted. */
  lateinit var source: String
}

@InvokeArg
internal class ShareArgs {
  /** Content URIs, or paths of files staged under the app's cache folder (`share/`). */
  lateinit var uris: List<String>
  lateinit var mime: String
}

@InvokeArg
internal class FindDocumentArgs {
  /** A path in the shared storage, such as `/storage/emulated/0/Download/PlastikWorld/box/box.mtl`. */
  lateinit var path: String
}

@InvokeArg
internal class PickDocumentsArgs {
  var multiple: Boolean = false
}

@InvokeArg
internal class DeleteDocumentArgs {
  lateinit var uri: String
}

@InvokeArg
internal class AuthorizeArgs {
  /** The OAuth scope wanted, such as `https://www.googleapis.com/auth/drive.file`. */
  lateinit var scope: String
  /** Only what is already granted: rather than ask the user, say `needs-sign-in`. */
  var silent: Boolean = false
}

@InvokeArg
internal class ClearTokenArgs {
  lateinit var token: String
}

@InvokeArg
internal class WriteDocumentArgs {
  lateinit var uri: String
  /** A file holding the bytes, copied in and then deleted. */
  lateinit var source: String
}

@TauriPlugin
class DevicePlugin(activity: Activity) : Plugin(activity), InputManager.InputDeviceListener {
  private var hardwareKeyboard = false
  private var keypadVisible = false
  /** Height of the keypad over the page, in CSS pixels. */
  private var keypadHeight = 0

  /**
   * The activity on screen. The plugin lives as long as the process, while Android may
   * rebuild the activity (a dock that changes the display, say), so this is taken afresh
   * from every lifecycle call rather than kept from construction.
   */
  private var host: Activity = activity
  /** The content view whose window insets are being watched. */
  private var watched: View? = null

  /** Files the app was asked to open (a tap in the Files app, a share to it), waiting to be fetched by the page. */
  private val opened = ArrayList<Uri>()

  override fun load(webView: WebView) {
    (webView.context as? Activity)?.let { host = it }
    takeIntent(host.intent)
    hardwareKeyboard = detectKeyboard()
    val inputManager = host.getSystemService(Context.INPUT_SERVICE) as InputManager
    inputManager.registerInputDeviceListener(this, null)
    watchKeypad()
  }

  /**
   * The keypad is seen in the window insets, read on the content view and handed on unchanged
   * (the activity's own listener on the webview keeps working). Attached again whenever the
   * content view is a new one.
   */
  private fun watchKeypad() {
    val content = host.findViewById<View>(android.R.id.content) ?: return
    if (watched === content) return
    watched = content
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      readKeypad(insets)
      insets
    }
    ViewCompat.getRootWindowInsets(content)?.let { readKeypad(it) }
    content.requestApplyInsets()
  }

  private fun readKeypad(insets: WindowInsetsCompat) {
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val visible = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > 0
    // The keypad's bottom covers the navigation bar, which the page does not extend under.
    val height = if (visible) (max(0, ime.bottom - bars.bottom) / host.resources.displayMetrics.density).roundToInt() else 0
    if (visible != keypadVisible || height != keypadHeight) {
      keypadVisible = visible
      keypadHeight = height
      announce()
    }
  }

  /**
   * Copies a file into a document picked through the system dialog, by way of the document's
   * provider: closing the provider's own stream is what tells it the document's new size, which a
   * raw descriptor never does (the Files app then shows the export as 0 B).
   */
  @Command
  fun writeDocument(invoke: Invoke) {
    val args = invoke.parseArgs(WriteDocumentArgs::class.java)
    val source = File(args.source)
    try {
      val out = host.contentResolver.openOutputStream(Uri.parse(args.uri), "wt")
        ?: throw IllegalStateException("The document could not be opened for writing")
      out.use { sink -> source.inputStream().use { it.copyTo(sink) } }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not write the document")
    } finally {
      source.delete()
    }
  }

  /** The files an intent asks the app to open: the viewed document, or the shared stream(s). */
  private fun filesOf(intent: Intent?): List<Uri> {
    intent ?: return emptyList()
    return when (intent.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND -> listOfNotNull(streamOf(intent))
      Intent.ACTION_SEND_MULTIPLE -> {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
      }
      else -> emptyList()
    }
  }

  private fun streamOf(intent: Intent): Uri? {
    @Suppress("DEPRECATION")
    return intent.getParcelableExtra(Intent.EXTRA_STREAM)
  }

  /** Keeps the files an intent brings, for `openedFiles`. True if there were any. */
  private fun takeIntent(intent: Intent?): Boolean {
    val files = filesOf(intent)
    opened.addAll(files)
    return files.isNotEmpty()
  }

  /** The app was running already (it is a single task) and was asked to open something else. */
  override fun onNewIntent(intent: Intent) {
    if (takeIntent(intent)) trigger("opened", JSObject())
  }

  /**
   * Asks Google Play services for an access token with the scope, through the
   * Android OAuth client registered for this package and signing key. The first
   * time, Google's own sheet asks the user; after that the grant is remembered
   * and the token comes back without a word. Resolves with `accessToken`.
   */
  @Command
  fun authorize(invoke: Invoke) {
    val args = invoke.parseArgs(AuthorizeArgs::class.java)
    val request = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(args.scope))).build()
    Identity.getAuthorizationClient(host)
      .authorize(request)
      .addOnSuccessListener { result ->
        if (!result.hasResolution()) {
          resolveToken(invoke, result)
        } else if (args.silent) {
          invoke.reject("needs-sign-in")
        } else {
          val sender = result.pendingIntent?.intentSender
          if (sender == null) invoke.reject("Google gave no way to ask for access")
          else startIntentSenderForResult(invoke, IntentSenderRequest.Builder(sender).build(), "authorized")
        }
      }
      .addOnFailureListener { e -> invoke.reject(describe(e)) }
  }

  @ActivityCallback
  fun authorized(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      invoke.reject("cancelled")
      return
    }
    try {
      resolveToken(invoke, Identity.getAuthorizationClient(host).getAuthorizationResultFromIntent(result.data))
    } catch (e: ApiException) {
      invoke.reject(describe(e))
    }
  }

  private fun resolveToken(invoke: Invoke, result: AuthorizationResult) {
    val token = result.accessToken
    if (token == null) {
      invoke.reject("Google gave no access token")
      return
    }
    val out = JSObject()
    out.put("accessToken", token)
    invoke.resolve(out)
  }

  /** Why Play services would not authorize, in words fit to show. */
  private fun describe(e: Exception): String {
    if (e is ApiException) {
      return when (e.statusCode) {
        CommonStatusCodes.CANCELED -> "cancelled"
        CommonStatusCodes.NETWORK_ERROR, CommonStatusCodes.TIMEOUT -> "Google could not be reached. Check the connection and try again."
        CommonStatusCodes.DEVELOPER_ERROR -> "This build is not registered with Google: its package name or signing key does not match the Android client."
        CommonStatusCodes.API_NOT_CONNECTED, CommonStatusCodes.SERVICE_DISABLED, ConnectionResult.SERVICE_MISSING, CommonStatusCodes.SERVICE_VERSION_UPDATE_REQUIRED -> "Google Play services is missing or out of date on this device."
        else -> e.message ?: "Google refused the sign-in (${e.statusCode})"
      }
    }
    return e.message ?: "Google refused the sign-in"
  }

  /** Forgets a token Play services holds, so that the account is asked again next time. */
  @Command
  fun clearToken(invoke: Invoke) {
    val args = invoke.parseArgs(ClearTokenArgs::class.java)
    Identity.getAuthorizationClient(host)
      .clearToken(ClearTokenRequest.builder().setToken(args.token).build())
      .addOnCompleteListener { invoke.resolve() }
  }

  /** The files waiting to be opened, as content URIs, handed over once. */
  @Command
  fun openedFiles(invoke: Invoke) {
    val out = JSObject()
    out.put("uris", JSArray(opened.map { it.toString() }))
    opened.clear()
    invoke.resolve(out)
  }

  /**
   * Asks for one or more documents of any type. Unlike the GET_CONTENT picker, an OPEN_DOCUMENT
   * grant lets the app change or delete what was picked, for the offer to remove a file brought in
   * as a project. Resolves with the content URIs, none if dismissed.
   */
  @Command
  fun pickDocuments(invoke: Invoke) {
    val args = invoke.parseArgs(PickDocumentsArgs::class.java)
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
    }
    startActivityForResult(invoke, intent, "documentsPicked")
  }

  @ActivityCallback
  fun documentsPicked(invoke: Invoke, result: ActivityResult) {
    val uris = ArrayList<String>()
    if (result.resultCode == Activity.RESULT_OK) {
      val data = result.data
      val clip: ClipData? = data?.clipData
      if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it.toString()) }
      else data?.data?.let { uris.add(it.toString()) }
    }
    val out = JSObject()
    out.put("uris", JSArray(uris))
    invoke.resolve(out)
  }

  /** Deletes a picked document, where its provider and the grant allow it. */
  @Command
  fun deleteDocument(invoke: Invoke) {
    val args = invoke.parseArgs(DeleteDocumentArgs::class.java)
    try {
      if (!DocumentsContract.deleteDocument(host.contentResolver, Uri.parse(args.uri))) throw IllegalStateException("The file's provider would not delete it")
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not delete the file")
    }
  }

  /** Asks for a folder; resolves with its document URI, or null if the picker was dismissed. */
  @Command
  fun pickFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
    startActivityForResult(invoke, intent, "folderPicked")
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val out = JSObject()
    val tree = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
    if (tree == null) {
      out.put("uri", null)
    } else {
      // Granted for as long as the app runs, which is as long as the export takes.
      host.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      out.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)).toString())
    }
    invoke.resolve(out)
  }

  /**
   * A type to create a document of the given name as, such that the name is kept: a provider
   * appends the extension it knows for the type when the name's own does not fit it (so a
   * `.mtl` made as text/plain comes out `.mtl.txt`). Where the system knows no type for the
   * extension, a private one keeps it from adding any.
   */
  private fun mimeFor(name: String, wanted: String): String {
    val extension = name.substringAfterLast('.', "").lowercase()
    if (extension.isEmpty() || extension == name.lowercase()) return wanted
    val map = MimeTypeMap.getSingleton()
    val forWanted = map.getExtensionFromMimeType(wanted)
    if (forWanted == null || forWanted.equals(extension, ignoreCase = true)) return wanted
    return map.getMimeTypeFromExtension(extension) ?: "application/x-$extension"
  }

  /** The type the system save dialog should create a document of this name as, for the name to be kept. */
  @Command
  fun mimeFor(invoke: Invoke) {
    val args = invoke.parseArgs(MimeForArgs::class.java)
    val out = JSObject()
    out.put("mime", mimeFor(args.name, args.mime))
    invoke.resolve(out)
  }

  /** Makes a document (or a folder) inside another; resolves with its URI. The provider may vary the name to keep it unique. */
  @Command
  fun createDocument(invoke: Invoke) {
    val args = invoke.parseArgs(CreateDocumentArgs::class.java)
    try {
      val mime = if (args.mime == DocumentsContract.Document.MIME_TYPE_DIR) args.mime else mimeFor(args.name, args.mime)
      val made = DocumentsContract.createDocument(host.contentResolver, Uri.parse(args.parent), mime, args.name)
        ?: throw IllegalStateException("The folder did not accept a new document")
      val out = JSObject()
      out.put("uri", made.toString())
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not create the document")
    }
  }

  /**
   * Writes an export into the app's own folder in Downloads (`Download/PlastikWorld/<folder>/`), where
   * the Files app and other apps can see it, through the media store, which needs no permission
   * for the app's own files. A file of the same name there is replaced. Resolves with the file's
   * content URI (for sharing) and its path as the Files app shows it.
   */
  @Command
  fun exportToDownloads(invoke: Invoke) {
    val args = invoke.parseArgs(ExportArgs::class.java)
    val source = File(args.source)
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IllegalStateException("Exports to Downloads need Android 10 or later")
      val relative = "Download/PlastikWorld" + (if (args.folder.isEmpty()) "" else "/" + args.folder) + "/"
      val resolver = host.contentResolver
      val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      // The media store would give a second file a numbered name; the old one goes first.
      resolver.query(collection, arrayOf(MediaStore.Downloads._ID), "${MediaStore.Downloads.RELATIVE_PATH} = ? AND ${MediaStore.Downloads.DISPLAY_NAME} = ?", arrayOf(relative, args.name), null)?.use { rows ->
        while (rows.moveToNext()) resolver.delete(android.content.ContentUris.withAppendedId(collection, rows.getLong(0)), null, null)
      }
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, args.name)
        put(MediaStore.Downloads.MIME_TYPE, mimeFor(args.name, args.mime))
        put(MediaStore.Downloads.RELATIVE_PATH, relative)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(collection, values) ?: throw IllegalStateException("Downloads did not accept the file")
      val out = resolver.openOutputStream(uri, "wt") ?: throw IllegalStateException("The file could not be opened for writing")
      out.use { sink -> source.inputStream().use { it.copyTo(sink) } }
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      val result = JSObject()
      result.put("uri", uri.toString())
      result.put("path", relative + args.name)
      invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not write the export")
    } finally {
      source.delete()
    }
  }

  /**
   * The content URI of a file at a path in the shared storage, from the media
   * store, which lists the app's own files (its exports) there without any
   * permission. Null for a path it does not know.
   */
  @Command
  fun findDocument(invoke: Invoke) {
    val args = invoke.parseArgs(FindDocumentArgs::class.java)
    val result = JSObject()
    result.put("uri", locate(args.path)?.toString())
    invoke.resolve(result)
  }

  private fun locate(path: String): Uri? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    // The volume's root is `/storage/emulated/0/` (or `/mnt/user/0/emulated/0/` as a descriptor shows it).
    val match = Regex("/emulated/\\d+/(.*/)?([^/]+)$").find(path) ?: return null
    val relative = match.groupValues[1]
    val name = match.groupValues[2]
    if (relative.isEmpty()) return null
    val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    host.contentResolver.query(collection, arrayOf(MediaStore.MediaColumns._ID), "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} = ?", arrayOf(relative, name), null)?.use { rows ->
      if (rows.moveToFirst()) return android.content.ContentUris.withAppendedId(collection, rows.getLong(0))
    }
    return null
  }

  /**
   * Opens the system share sheet with the given files: documents by URI, or
   * files staged in the cache by path, which go out through the app's own
   * FileProvider (the one Tauri declares, whose paths cover the cache folder).
   */
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    try {
      val uris = ArrayList<Uri>(args.uris.map { if (it.contains("://")) Uri.parse(it) else FileProvider.getUriForFile(host, host.packageName + ".fileprovider", File(it)) })
      val intent = if (uris.size == 1) {
        Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
      }
      intent.type = args.mime
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      host.startActivity(Intent.createChooser(intent, null))
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not share")
    }
  }

  @Command
  fun state(invoke: Invoke) {
    // Asked afresh: the insets are read again in case a change went by unseen.
    watchKeypad()
    watched?.let { view -> ViewCompat.getRootWindowInsets(view)?.let { readKeypad(it) } }
    invoke.resolve(current())
  }

  private fun current(): JSObject {
    val out = JSObject()
    out.put("hardwareKeyboard", hardwareKeyboard)
    out.put("keypadVisible", keypadVisible)
    out.put("keypadHeight", keypadHeight)
    return out
  }

  private fun announce() {
    trigger("change", current())
  }

  /** A keyboard the user can type on: what the configuration says, or any attached alphabetic keyboard device. */
  private fun detectKeyboard(config: Configuration = host.resources.configuration): Boolean {
    val byConfiguration = config.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
    val byDevices = InputDevice.getDeviceIds().any { id ->
      val device = InputDevice.getDevice(id) ?: return@any false
      !device.isVirtual &&
        (device.sources and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
        device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    }
    return byConfiguration || byDevices
  }

  private fun keyboardMayHaveChanged(config: Configuration = host.resources.configuration) {
    val now = detectKeyboard(config)
    if (now != hardwareKeyboard) {
      hardwareKeyboard = now
      announce()
    }
    watchKeypad()
    watched?.let { view -> ViewCompat.getRootWindowInsets(view)?.let { readKeypad(it) } }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    keyboardMayHaveChanged(newConfig)
  }

  override fun onRestart(activity: AppCompatActivity) {
    host = activity
  }

  override fun onResume(activity: AppCompatActivity) {
    host = activity
    keyboardMayHaveChanged()
  }

  override fun onInputDeviceAdded(deviceId: Int) = keyboardMayHaveChanged()
  override fun onInputDeviceRemoved(deviceId: Int) = keyboardMayHaveChanged()
  override fun onInputDeviceChanged(deviceId: Int) = keyboardMayHaveChanged()
}
