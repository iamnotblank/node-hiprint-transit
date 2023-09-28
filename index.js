/*
 * @Date: 2023-09-28 19:28:42
 * @LastEditors: admin@54xavier.cn
 * @LastEditTime: 2023-10-12 17:40:42
 * @FilePath: \node-hiprint-transit\index.js
 */
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { I18n } from "i18n";
import { Server } from "socket.io";
import forge from "node-forge";
import { toUnicode } from "punycode";
import log from "./src/log.js";
import { readConfig, getIPAddress } from "./src/config.js";

// ES Module need use fileURLToPath to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Setup i18n
const i18n = new I18n({
  locales: ["en", "zh"],
  directory: path.join(__dirname, "./src/locales"),
  defaultLocale: "en",
});

const CLIENT = {};

// Read config first and then start serve
readConfig().then((CONFIG) => {
  const { port, token, useSSL, lang } = CONFIG;
  var ipAddress = `http://${getIPAddress()}:${port}`;
  i18n.setLocale(lang);
  var server;
  if (useSSL) {
    const key = readFileSync("./src/ssl.key", "utf-8");
    const cert = readFileSync("./src/ssl.pem", "utf-8");
    // Check SSL certificate
    if (!key || !cert) {
      console.error(chalk.red(i18n.__("SSL certificate is missing")));
      process.exit(1);
    }
    const certificate = forge.pki.certificateFromPem(cert);
    // Check SSL certificate is expired
    if (new Date(certificate.validity.notAfter) < new Date()) {
      console.warn(chalk.red(i18n.__("SSL certificate has expired")));
    }
    server = https.createServer({
      key,
      cert,
    });
    // Get all domains from certificate
    const domains = certificate.extensions
      .find(({ name }) => name === "subjectAltName")
      .altNames.map(({ value }) => toUnicode(value));
    ipAddress = domains.map((value) => `https://${value}:${port}`).join("\n");
  } else {
    server = http.createServer();
  }

  // Setup socket.io
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  server.listen(port, () => {
    log(i18n.__("Serve is start"));
    console.log(
      i18n.__(
        "Serve is running on\n%s\n\nPlease make sure that the ports have been opened in the security group or firewall.\ntoken: %s",
        chalk.green.underline(ipAddress),
        chalk.green(token)
      )
    );
  });

  // Authentication
  io.use((socket, next) => {
    if (token && socket.handshake.auth.token === token) {
      next();
    } else {
      log(i18n.__("Authentication failed for %s", socket.id));
      next(new Error("Authentication failed"));
    }
  });

  // Socket.io Add event listener
  io.on("connection", (socket) => {
    if (socket.handshake.query.test !== "true") {
      if (socket.handshake.query.client === "electron-hiprint") {
        log(i18n.__("Client connected: %s", socket.id + "(electron-hiprint)"));
      } else {
        log(i18n.__("Client connected: %s", socket.id + "(web-client)"));

        // Send client list to web client
        socket.emit("clients", CLIENT);

        // Send all printer list to web client
        var allPrinterList = [];
        Object.keys(CLIENT).forEach((key) => {
          CLIENT[key].printerList.forEach((printer) => {
            allPrinterList.push({
              ...printer,
              server: Object.assign({}, CLIENT[key], {
                printerList: undefined,
              }),
            });
          });
        });
        socket.emit("printerList", allPrinterList);
      }
    } else {
      log(i18n.__("Client connected: %s", socket.id + " (test)"));
    }

    // Get client info
    socket.on("clientInfo", (data) => {
      CLIENT[socket.id] = Object.assign({}, CLIENT[socket.id], data);
    });

    // Get client printer list
    socket.on("printerList", (printerList) => {
      CLIENT[socket.id] = Object.assign({}, CLIENT[socket.id], { printerList });
    });

    // Get all client list
    socket.on("getClients", () => {
      socket.emit("clients", CLIENT);
    });

    // Get all clients printer list
    socket.on("refreshPrinterList", () => {
      io.to("electron-hiprint").emit("refreshPrinterList");

      // Just wait 2 seconds for the client to update the printer list
      // Of course, this is not a good way to do it. But it’s not like it can’t be used 🤪
      setTimeout(() => {
        var allPrinterList = [];
        Object.keys(CLIENT).forEach((key) => {
          CLIENT[key].printerList.forEach((printer) => {
            allPrinterList.push({
              ...printer,
              server: Object.assign({}, CLIENT[key], {
                printerList: undefined,
              }),
              clientId: key,
            });
          });
        });
        socket.emit("printerList", allPrinterList);
      }, 1000 * 2);
    });

    // Get client address info, is not supported
    socket.on("address", () => {
      socket.emit(
        "address",
        "Address is not supported in transit server, you should use getClients."
      );
    });

    // Make a ipp print to electron-hiprint client
    socket.on("ippPrint", (options) => {
      if (options.client) {
        if (!CLIENT[options.client]) {
          socket.emit("error", {
            msg: "Client is not exist."
          });
          return;
        }
        socket
          .to(options.client)
          .emit("ippPrint", { ...options, replyId: socket.id });
        log(i18n.__("%s send ippPrint to %s", socket.id, options.client));
      } else {
        socket.emit("error", {
          msg: "Client must be specified."
        });
      }
    });

    // Make a ipp printer connected event to reply client
    socket.on("ippPrinterConnected", (options) => {
      if (options.replyId && options.printer) {
        socket.to(options.replyId).emit("ippPrinterConnected", options.printer);
      }
    });

    // Make a ipp printer callback to reply client
    socket.on("ippPrinterCallback", (options, res) => {
      if (options.replyId) {
        socket.to(options.replyId).emit("ippPrinterCallback", options, res);
      }
    });

    // Make a ipp request to electron-hiprint client
    socket.on("ippRequest", (options) => {
      if (options.client) {
        if (!CLIENT[options.client]) {
          socket.emit("error", {
            msg: "Client is not exist."
          });
          return;
        }
        socket
          .to(options.client)
          .emit("ippRequest", { ...options, replyId: socket.id });
        log(i18n.__("%s send ippRequest to %s", socket.id, options.client));
      } else {
        socket.emit("error", {
          msg: "Client must be specified."
        });
      }
    });

    // Make a ipp request callback to reply client
    socket.on("ippRequestCallback", (options, res) => {
      if (options.replyId) {
        socket.to(options.replyId).emit("ippRequestCallback", options, res);
      }
    })

    // Make a news to electron-hiprint client
    socket.on("news", (options) => {
      if (options.client) {
        if (!CLIENT[options.client]) {
          socket.emit("error", {
            msg: "Client is not exist.",
            templateId: options.templateId,
          });
          return;
        }
        socket
          .to(options.client)
          .emit("news", { ...options, replyId: socket.id });
        log(i18n.__("%s send news to %s", socket.id, options.client));
      } else {
        socket.emit("error", {
          msg: "Client must be specified.",
          templateId: options.templateId,
        });
      }
    });

    // Make a success callback to reply client
    socket.on("success", (options) => {
      if (options.replyId) {
        socket.to(options.replyId).emit("success", options);
        log(i18n.__("%s client: print success, templateId: %s", socket.id, options.templateId))
      }
    })

    // Make a error callback to reply client
    socket.on("error", (options) => {
      if (options.replyId) {
        socket.to(options.replyId).emit("error", options);
        log(i18n.__("%s client: print error, templateId: %s", socket.id, options.templateId))
      }
    })

    // Client disconnect
    socket.on("disconnect", () => {
      if (socket.handshake.query.test !== "true") {
        log(i18n.__("Client disconnected: %s", socket.id));
        delete CLIENT[socket.id];
      }
    });
  });

  // Retrieve the client print list every 10 minutes.
  setInterval(() => {
    log(i18n.__("Retrieve the client print list"))
    io.to("electron-hiprint").emit("refreshPrinterList");
  }, 1000 * 60 * 10);
});

// Close serve
process.on("SIGINT", () => {
  log(i18n.__("Serve is closed")).then(() => {
    process.exit(0); // 退出进程
  });
});
