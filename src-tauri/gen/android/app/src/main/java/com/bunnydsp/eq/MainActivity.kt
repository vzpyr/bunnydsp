package com.bunnydsp.eq

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    private val ACTION_USB_PERMISSION = "com.bunnydsp.eq.USB_PERMISSION"
    private lateinit var usbManager: UsbManager
    private var usbReceiver: BroadcastReceiver? = null

    companion object {
        private var instance: MainActivity? = null
        private var usbConnection: UsbDeviceConnection? = null
        private var usbInterface: UsbInterface? = null
        private var inEndpoint: UsbEndpoint? = null
        private var outEndpoint: UsbEndpoint? = null

        init {
            System.loadLibrary("bunnydsp")
        }

        @JvmStatic
        fun forceConnect(): Boolean {
            val inst = instance
            if (inst != null) {
                inst.runOnUiThread {
                    inst.checkAndConnectUsb()
                }
                return true
            }
            return false
        }

        // Called from Rust via JNI to send reports
        @JvmStatic
        fun writeReport(data: ByteArray): Boolean {
            val conn = usbConnection ?: return false
            val epOut = outEndpoint
            if (epOut != null) {
                val res = conn.bulkTransfer(epOut, data, data.size, 100)
                if (res >= 0) return true
            }

            // Fallback: Control Transfer (SET_REPORT)
            val reportId = data[0].toInt() and 0xFF
            val value = (0x02 shl 8) or reportId // 0x02 is HID Output Report Type
            val intfNum = usbInterface?.id ?: 0
            val res = conn.controlTransfer(0x21, 0x09, value, intfNum, data, data.size, 100)
            return res >= 0
        }

        // Called from Rust via JNI to read reports
        @JvmStatic
        fun readReport(timeoutMs: Int): ByteArray? {
            val conn = usbConnection ?: return null
            val epIn = inEndpoint
            val buffer = ByteArray(64)
            if (epIn != null) {
                val res = conn.bulkTransfer(epIn, buffer, buffer.size, timeoutMs)
                if (res > 0) {
                    return buffer.copyOf(res)
                }
            }

            // Fallback: Control Transfer (GET_REPORT)
            val reportId = 0x4B // The read report ID
            val value = (0x01 shl 8) or reportId // 0x01 is HID Input Report Type
            val intfNum = usbInterface?.id ?: 0
            val res = conn.controlTransfer(0xa1, 0x01, value, intfNum, buffer, buffer.size, timeoutMs)
            if (res > 0) {
                return buffer.copyOf(res)
            }
            return null
        }
    }

    // JNI Native methods
    private external fun registerActivity(activity: MainActivity)
    private external fun setConnectedStatus(connected: Boolean)

    override fun onCreate(savedInstanceState: Bundle?) {
        instance = this
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // Register this activity instance with Rust JNI
        registerActivity(this)

        usbManager = getSystemService(Context.USB_SERVICE) as UsbManager

        usbReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val action = intent.action
                if (ACTION_USB_PERMISSION == action) {
                    synchronized(this) {
                        val device: UsbDevice? = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                        if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                            device?.let { openDevice(it) }
                        } else {
                            Log.d("BunnyDSP", "Permission denied for device: $device")
                        }
                    }
                } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED == action) {
                    Log.d("BunnyDSP", "USB device attached")
                    checkAndConnectUsb()
                } else if (UsbManager.ACTION_USB_DEVICE_DETACHED == action) {
                    val device: UsbDevice? = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                    if (device != null && device.vendorId == 0x31b2 && device.productId == 0x1112) {
                        Log.d("BunnyDSP", "DSP device detached")
                        closeDevice()
                    }
                }
            }
        }

        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(usbReceiver, filter)
        }
    }

    override fun onResume() {
        super.onResume()
        checkAndConnectUsb()
    }

    override fun onDestroy() {
        super.onDestroy()
        usbReceiver?.let { unregisterReceiver(it) }
        closeDevice()
        if (instance == this) {
            instance = null
        }
    }

    private fun checkAndConnectUsb() {
        if (usbConnection != null) {
            // Already connected
            setConnectedStatus(true)
            return
        }

        val deviceList = usbManager.deviceList
        for (device in deviceList.values) {
            // VID = 0x31b2, PID = 0x1112
            if (device.vendorId == 0x31b2 && device.productId == 0x1112) {
                if (usbManager.hasPermission(device)) {
                    openDevice(device)
                } else {
                    val permissionIntent = PendingIntent.getBroadcast(
                        this, 0, Intent(ACTION_USB_PERMISSION),
                        PendingIntent.FLAG_IMMUTABLE
                    )
                    usbManager.requestPermission(device, permissionIntent)
                }
                break
            }
        }
    }

    private fun openDevice(device: UsbDevice) {
        val conn = usbManager.openDevice(device)
        if (conn != null) {
            // Find the HID interface (class 3)
            var hidIntf: UsbInterface? = null
            for (i in 0 until device.interfaceCount) {
                val intf = device.getInterface(i)
                if (intf.interfaceClass == 3) { // 3 is USB_CLASS_HID
                    hidIntf = intf
                    break
                }
            }
            val intf = hidIntf ?: device.getInterface(0)

            if (conn.claimInterface(intf, true)) {
                usbConnection = conn
                usbInterface = intf

                // Find endpoints
                inEndpoint = null
                outEndpoint = null
                for (j in 0 until intf.endpointCount) {
                    val ep = intf.getEndpoint(j)
                    if (ep.type == UsbConstants.USB_ENDPOINT_XFER_INT || ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                        if (ep.direction == UsbConstants.USB_DIR_IN) {
                            inEndpoint = ep
                        } else if (ep.direction == UsbConstants.USB_DIR_OUT) {
                            outEndpoint = ep
                        }
                    }
                }
                Log.d("BunnyDSP", "Interface claimed. IN: $inEndpoint, OUT: $outEndpoint")
                setConnectedStatus(true)
            } else {
                Log.e("BunnyDSP", "Failed to claim interface")
                conn.close()
            }
        } else {
            Log.e("BunnyDSP", "Failed to open USB device connection")
        }
    }

    private fun closeDevice() {
        try {
            usbInterface?.let {
                usbConnection?.releaseInterface(it)
            }
            usbConnection?.close()
        } catch (e: Exception) {
            Log.e("BunnyDSP", "Error closing device: ${e.message}")
        } finally {
            usbConnection = null
            usbInterface = null
            inEndpoint = null
            outEndpoint = null
            setConnectedStatus(false)
        }
    }
}
