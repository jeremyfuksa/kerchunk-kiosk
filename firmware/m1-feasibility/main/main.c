// M1 step 1: USB host enumeration.
//
// Goal: prove the ESP32-S3 can act as a USB host and detect a plugged-in
// device. Prints the VID/PID of any device that appears. We expect the
// Nooelec Nano 3 to enumerate as VID 0x0bda PID 0x2838 (Realtek RTL2838U).
//
// Next step (not in this file yet): send the RTL2832U init sequence and
// pull I/Q samples off the bulk endpoint.

#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "usb/usb_host.h"

static const char *TAG = "kerchunk-m1";

// Background task: drives the USB host library's event loop.
// Without this, no enumeration callbacks ever fire.
static void usb_host_lib_task(void *arg) {
    while (1) {
        uint32_t event_flags;
        usb_host_lib_handle_events(portMAX_DELAY, &event_flags);
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            ESP_LOGI(TAG, "usb host: no clients");
        }
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_ALL_FREE) {
            ESP_LOGI(TAG, "usb host: all devices freed");
        }
    }
}

static usb_host_client_handle_t g_client_hdl;

// Client callback: fires when a device is connected or disconnected.
static void client_event_cb(const usb_host_client_event_msg_t *event_msg, void *arg) {
    usb_host_client_handle_t client_hdl = g_client_hdl;

    switch (event_msg->event) {
    case USB_HOST_CLIENT_EVENT_NEW_DEV: {
        uint8_t addr = event_msg->new_dev.address;
        ESP_LOGI(TAG, "usb: new device at address %d", addr);

        usb_device_handle_t dev_hdl;
        if (usb_host_device_open(client_hdl, addr, &dev_hdl) != ESP_OK) {
            ESP_LOGW(TAG, "usb: failed to open device");
            return;
        }

        const usb_device_desc_t *desc;
        if (usb_host_get_device_descriptor(dev_hdl, &desc) == ESP_OK) {
            ESP_LOGI(TAG, "usb: VID=0x%04x PID=0x%04x class=0x%02x",
                     desc->idVendor, desc->idProduct, desc->bDeviceClass);
            if (desc->idVendor == 0x0bda && desc->idProduct == 0x2838) {
                ESP_LOGI(TAG, "usb: this is the RTL2838U dongle");
            }
        }
        usb_host_device_close(client_hdl, dev_hdl);
        break;
    }
    case USB_HOST_CLIENT_EVENT_DEV_GONE:
        ESP_LOGI(TAG, "usb: device gone");
        break;
    default:
        break;
    }
}

// Background task: drives one USB client's event loop.
static void usb_client_task(void *arg) {
    usb_host_client_config_t client_config = {
        .is_synchronous = false,
        .max_num_event_msg = 5,
        .async = {
            .client_event_callback = client_event_cb,
            .callback_arg = NULL,
        },
    };
    ESP_ERROR_CHECK(usb_host_client_register(&client_config, &g_client_hdl));

    while (1) {
        usb_host_client_handle_events(g_client_hdl, portMAX_DELAY);
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "kerchunk m1: usb host scaffold");

    const usb_host_config_t host_config = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LEVEL1,
    };
    ESP_ERROR_CHECK(usb_host_install(&host_config));
    ESP_LOGI(TAG, "usb host installed");

    xTaskCreate(usb_host_lib_task, "usb_lib", 4096, NULL, 5, NULL);
    xTaskCreate(usb_client_task,  "usb_cli", 4096, NULL, 4, NULL);

    ESP_LOGI(TAG, "waiting for usb device on the USB-OTG port...");
}
