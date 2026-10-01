import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.*;
import java.math.BigDecimal;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class StoreFlowServer {
    
    // --- SERVER CONFIGURATION ---
    private static final int DEFAULT_PORT = 8080;
    private static final long SESSION_TTL_MS = 8L * 60 * 60 * 1000;
    private static final long DELIVERY_FEE = 3900;
    private static final long FREE_DELIVERY_OVER = 50000;
    private static final Pattern EMAIL_PATTERN = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$");

    // --- APPLICATION STATE (In-Memory / Concurrency Safe) ---
    private static final Map<String, Session> SESSIONS = new ConcurrentHashMap<>();
    private static final Map<String, Pending> PENDING = new ConcurrentHashMap<>();
    private static final Map<String, long[]> FAILS = new ConcurrentHashMap<>();

    public static void main(String[] args) throws Exception {
        Database.initialize();
        Router.initialize();

        int port = Integer.parseInt(System.getenv().getOrDefault("STOREFLOW_PORT", String.valueOf(DEFAULT_PORT)));
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        server.createContext("/", Router::handleRequest);
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(8));
        server.start();

        System.out.println("7/11 Online Convenience Store is running at http://localhost:" + port);
        System.out.println("Demo employee logins -> admin / admin123   and   cashier / cashier123");
    }

    // =========================================================================================
    // 1. ROUTING & CONTROLLERS (API Endpoints)
    // =========================================================================================

    static class Router {
        private static final List<Route> routes = new ArrayList<>();

        @FunctionalInterface interface Endpoint { void handle(HttpExchange x, Matcher m) throws Exception; }
        private record Route(String method, Pattern pattern, Endpoint endpoint) {}

        static void get(String regex, Endpoint e) { routes.add(new Route("GET", Pattern.compile(regex), e)); }
        static void post(String regex, Endpoint e) { routes.add(new Route("POST", Pattern.compile(regex), e)); }
        static void put(String regex, Endpoint e) { routes.add(new Route("PUT", Pattern.compile(regex), e)); }
        static void delete(String regex, Endpoint e) { routes.add(new Route("DELETE", Pattern.compile(regex), e)); }

        static void initialize() {
            // Auth Routes
            post("/api/auth/register", AuthController::register);
            post("/api/auth/guest", AuthController::guest);
            post("/api/auth/login", AuthController::login);
            post("/api/auth/logout", AuthController::logout);
            post("/api/auth/logout-all", AuthController::logoutAll);
            get("/api/auth/me", AuthController::me);

            // Account & Settings
            get("/api/account", AccountController::getAccount);
            post("/api/account/profile", AccountController::updateProfile);
            post("/api/account/password", AccountController::updatePassword);
            post("/api/account/email", AccountController::requestEmailVerify);
            post("/api/account/phone", AccountController::requestPhoneVerify);
            post("/api/account/email/verify", AccountController::verifyEmail);
            post("/api/account/phone/verify", AccountController::verifyPhone);
            get("/api/account/avatar", AccountController::getAvatar);
            post("/api/account/avatar", AccountController::setAvatar);
            delete("/api/account/avatar", AccountController::deleteAvatar);

            // E-Commerce Core Routes
            get("/api/state", CoreController::getState);
            post("/api/wishlist/([0-9]+)", CoreController::toggleWishlist);
            post("/api/addresses", CoreController::addAddress);
            delete("/api/addresses/([0-9]+)", CoreController::deleteAddress);
            
            // Products
            post("/api/products", ProductController::createProduct);
            put("/api/products/([0-9]+)", ProductController::updateProduct);
            delete("/api/products/([0-9]+)", ProductController::deleteProduct);
            post("/api/products/([0-9]+)/expiry", ProductController::updateExpiry);
            post("/api/products/([0-9]+)/stock", ProductController::updateStock);
            
            // Sales & Checkout
            post("/api/sales", CheckoutController::checkout);
            post("/api/sales/([0-9]+)/status", CheckoutController::updateStatus);

            // Static Files
            get("/api/backgrounds", StaticController::getBackgrounds);
            get("/img/([^/\\\\]+)", StaticController::getImage);
            get("(/|/index\\.html|/styles\\.css|/app\\.js)", StaticController::getStaticAsset);
        }

        static void handleRequest(HttpExchange x) throws IOException {
            try {
                String path = x.getRequestURI().getPath();
                String method = x.getRequestMethod();

                for (Route route : routes) {
                    if (!route.method.equals(method)) continue;
                    Matcher m = route.pattern.matcher(path);
                    if (m.matches()) {
                        route.endpoint.handle(x, m);
                        return;
                    }
                }
                throw new ResourceNotFoundException("Endpoint not found.");
            } catch (DomainException e) {
                HttpUtils.respondJson(x, e.status, """
                    {"error": %s}""".formatted(JsonMapper.quote(e.getMessage())));
            } catch (Exception e) {
                e.printStackTrace();
                HttpUtils.respondJson(x, 500, """
                    {"error": "Internal Server Error"}""");
            } finally {
                x.close();
            }
        }
    }

    // --- Controllers ---

    static class AuthController {
        static void register(HttpExchange x, Matcher m) throws Exception {
            Map<String, String> f = HttpUtils.parseForm(x);
            User u = AuthService.registerCustomer(
                HttpUtils.req(f, "username"), HttpUtils.req(f, "name"), HttpUtils.req(f, "password"));
            AuthService.setSessionCookie(x, u.id);
            HttpUtils.respondJson(x, 201, JsonMapper.toJson(u));
        }
        
        static void guest(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.createGuest();
            AuthService.setSessionCookie(x, u.id);
            HttpUtils.respondJson(x, 201, JsonMapper.toJson(u));
        }

        static void login(HttpExchange x, Matcher m) throws Exception {
            Map<String, String> f = HttpUtils.parseForm(x);
            User u = AuthService.login(HttpUtils.req(f, "username"), HttpUtils.req(f, "password"));
            AuthService.setSessionCookie(x, u.id);
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(u));
        }

        static void logout(HttpExchange x, Matcher m) throws Exception {
            AuthService.clearSessionCookie(x);
            HttpUtils.respondJson(x, 200, """
                {"ok":true}""");
        }

        static void logoutAll(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            SESSIONS.entrySet().removeIf(e -> e.getValue().userId == u.id);
            AuthService.clearSessionCookie(x);
            HttpUtils.respondJson(x, 200, """
                {"ok":true}""");
        }

        static void me(HttpExchange x, Matcher m) throws Exception {
            Optional<User> u = AuthService.currentUser(x);
            HttpUtils.respondJson(x, 200, u.map(user -> """
                {"user": %s}""".formatted(JsonMapper.toJson(user)))
                .orElse("""
                {"user": null}"""));
        }
    }

    static class AccountController {
        static void getAccount(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            HttpUtils.respondJson(x, 200, Database.read(s -> JsonMapper.toJsonAccount(s, u)));
        }

        static void updateProfile(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireMember(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            Database.transaction(s -> AccountService.updateProfile(s, u.id, f));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(Database.findUser(u.id)));
        }

        static void updatePassword(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireMember(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            Database.transaction(s -> AccountService.changePassword(s, u.id, f));
            
            String keepCookie = HttpUtils.cookie(x, "sid");
            SESSIONS.entrySet().removeIf(e -> e.getValue().userId == u.id && !e.getKey().equals(keepCookie));
            HttpUtils.respondJson(x, 200, """
                {"ok":true}""");
        }
        
        static void requestEmailVerify(HttpExchange x, Matcher m) throws Exception { requestContactVerify(x, true); }
        static void requestPhoneVerify(HttpExchange x, Matcher m) throws Exception { requestContactVerify(x, false); }
        private static void requestContactVerify(HttpExchange x, boolean isEmail) throws Exception {
            User u = AuthService.requireMember(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            String code = Database.transactionWithResult(s -> AccountService.setContact(s, u.id, isEmail, f.getOrDefault("value", "")));
            HttpUtils.respondJson(x, 200, """
                {"user": %s, "demoCode": %s}""".formatted(
                JsonMapper.toJson(Database.findUser(u.id)),
                code == null ? "null" : JsonMapper.quote(code)
            ));
        }

        static void verifyEmail(HttpExchange x, Matcher m) throws Exception { verifyContact(x, true); }
        static void verifyPhone(HttpExchange x, Matcher m) throws Exception { verifyContact(x, false); }
        private static void verifyContact(HttpExchange x, boolean isEmail) throws Exception {
            User u = AuthService.requireMember(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            Database.transaction(s -> AccountService.verifyContact(s, u.id, isEmail, HttpUtils.req(f, "code")));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(Database.findUser(u.id)));
        }

        static void getAvatar(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            if (u.avatar == null) throw new ResourceNotFoundException("No profile picture.");
            HttpUtils.respondBytes(x, 200, u.avatarMime, u.avatar);
        }

        static void setAvatar(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireMember(x);
            Map<String, String> f = HttpUtils.parseForm(x, 1_500_000);
            Database.transaction(s -> AccountService.setAvatar(s, u.id, HttpUtils.req(f, "image")));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(Database.findUser(u.id)));
        }

        static void deleteAvatar(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireMember(x);
            Database.transaction(s -> {
                User dbUser = Database.findUserInState(s, u.id);
                dbUser.avatar = null; dbUser.avatarMime = null; dbUser.avatarVer = 0;
            });
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(Database.findUser(u.id)));
        }
    }

    static class CoreController {
        static void getState(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            HttpUtils.respondJson(x, 200, Database.read(s -> JsonMapper.toJsonState(s, u)));
        }

        static void toggleWishlist(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            long productId = Long.parseLong(m.group(1));
            Database.transaction(s -> {
                User dbUser = Database.findUserInState(s, u.id);
                if (Database.findProductInState(s, productId).isEmpty()) throw new BadRequestException("Product not found");
                if (!dbUser.wl().remove(productId)) dbUser.wl().add(productId);
            });
            HttpUtils.respondJson(x, 200, """
                {"wishlist": %s}""".formatted(JsonMapper.toJsonWishlist(Database.findUser(u.id))));
        }

        static void addAddress(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireMember(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            Database.transaction(s -> AccountService.addAddress(s, u.id, f));
            HttpUtils.respondJson(x, 201, """
                {"addresses": %s}""".formatted(JsonMapper.toJsonAddresses(Database.findUser(u.id))));
        }

        static void deleteAddress(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireMember(x);
            long addressId = Long.parseLong(m.group(1));
            Database.transaction(s -> Database.findUserInState(s, u.id).addr().removeIf(a -> a.id == addressId));
            HttpUtils.respondJson(x, 200, """
                {"addresses": %s}""".formatted(JsonMapper.toJsonAddresses(Database.findUser(u.id))));
        }
    }

    static class ProductController {
        static void createProduct(HttpExchange x, Matcher m) throws Exception {
            AuthService.requireStaff(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            Product p = Database.transactionWithResult(s -> ProductService.createProduct(s, f));
            HttpUtils.respondJson(x, 201, JsonMapper.toJson(p));
        }

        static void updateProduct(HttpExchange x, Matcher m) throws Exception {
            AuthService.requireStaff(x);
            long id = Long.parseLong(m.group(1));
            Map<String, String> f = HttpUtils.parseForm(x);
            Product p = Database.transactionWithResult(s -> ProductService.updateProduct(s, id, f));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(p));
        }

        static void deleteProduct(HttpExchange x, Matcher m) throws Exception {
            AuthService.requireStaff(x);
            long id = Long.parseLong(m.group(1));
            Database.transaction(s -> s.products.removeIf(p -> p.id == id));
            HttpUtils.respondJson(x, 200, """
                {"ok":true}""");
        }

        static void updateExpiry(HttpExchange x, Matcher m) throws Exception {
            AuthService.requireStaff(x);
            long id = Long.parseLong(m.group(1));
            Map<String, String> f = HttpUtils.parseForm(x);
            Product p = Database.transactionWithResult(s -> ProductService.updateExpiry(s, id, f.get("expiry")));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(p));
        }

        static void updateStock(HttpExchange x, Matcher m) throws Exception {
            AuthService.requireStaff(x);
            long id = Long.parseLong(m.group(1));
            Map<String, String> f = HttpUtils.parseForm(x);
            Product p = Database.transactionWithResult(s -> ProductService.updateStock(s, id, HttpUtils.req(f, "change")));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(p));
        }
    }

    static class CheckoutController {
        static void checkout(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            Map<String, String> f = HttpUtils.parseForm(x);
            Sale sale = Database.transactionWithResult(s -> OrderService.checkout(s, u, f));
            HttpUtils.respondJson(x, 201, JsonMapper.toJson(sale));
        }

        static void updateStatus(HttpExchange x, Matcher m) throws Exception {
            User u = AuthService.requireAuth(x);
            long id = Long.parseLong(m.group(1));
            Map<String, String> f = HttpUtils.parseForm(x);
            Sale sale = Database.transactionWithResult(s -> OrderService.updateStatus(s, u, id, HttpUtils.req(f, "status")));
            HttpUtils.respondJson(x, 200, JsonMapper.toJson(sale));
        }
    }

    static class StaticController {
        static void getBackgrounds(HttpExchange x, Matcher m) throws Exception {
            Path dir = Path.of("public", "img");
            List<String> images = new ArrayList<>();
            if (Files.isDirectory(dir)) {
                try (var stream = Files.list(dir)) {
                    stream.map(f -> f.getFileName().toString())
                          .filter(n -> n.matches("(?i)store-[A-Za-z0-9_-]+\\.(jpg|jpeg|png|webp)"))
                          .sorted()
                          .forEach(n -> images.add(JsonMapper.quote("/img/" + n)));
                }
            }
            HttpUtils.respondJson(x, 200, """
                {"images": [%s]}""".formatted(String.join(",", images)));
        }

        static void getImage(HttpExchange x, Matcher m) throws Exception {
            String filename = m.group(1);
            if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
                throw new ForbiddenException("Invalid path");
            }
            Path file = Path.of("public", "img", filename);
            if (!Files.isRegularFile(file)) throw new ResourceNotFoundException("Not found");
            
            String lower = filename.toLowerCase(Locale.ROOT);
            String type = lower.endsWith(".svg") ? "image/svg+xml" : lower.endsWith(".png") ? "image/png" 
                        : lower.endsWith(".webp") ? "image/webp" : lower.endsWith(".gif") ? "image/gif" : "image/jpeg";
            
            HttpUtils.respondBytes(x, 200, type, Files.readAllBytes(file));
        }

        static void getStaticAsset(HttpExchange x, Matcher m) throws Exception {
            String path = m.group(1);
            String filename = path.equals("/") ? "index.html" : path.substring(1);
            String type = filename.endsWith(".css") ? "text/css" : filename.endsWith(".js") ? "text/javascript" : "text/html";
            
            Path file = Path.of("public", filename);
            if (!Files.isRegularFile(file)) throw new ResourceNotFoundException("Not found");
            HttpUtils.respondBytes(x, 200, type + "; charset=utf-8", Files.readAllBytes(file));
        }
    }


    // =========================================================================================
    // 2. SERVICES (Business Logic)
    // =========================================================================================

    static class AuthService {
        static User registerCustomer(String username, String name, String password) {
            String userLower = username.toLowerCase(Locale.ROOT);
            HttpUtils.validate(userLower.matches("[a-z0-9_]+"), "Username may only use letters, numbers and underscores.");
            HttpUtils.validate(password.length() >= 6 && password.length() <= 100, "Password must be 6-100 characters.");
            HttpUtils.validate(userLower.length() >= 3 && userLower.length() <= 24, "Username must be 3 to 24 characters.");

            return Database.transactionWithResult(s -> {
                if (s.users.stream().anyMatch(u -> u.username.equals(userLower))) {
                    throw new BadRequestException("That username is already taken.");
                }
                String salt = CryptoUtils.randomSalt();
                User u = new User(s.nextUser++, userLower, name, Role.CUSTOMER.value, CryptoUtils.hashPassword(password, salt), salt);
                s.users.add(u);
                return u;
            });
        }

        static User createGuest() {
            return Database.transactionWithResult(s -> {
                String suffix = String.format("%04d", new SecureRandom().nextInt(10000));
                String salt = CryptoUtils.randomSalt();
                User u = new User(s.nextUser++, "guest" + suffix, "Guest Shopper", Role.CUSTOMER.value, CryptoUtils.randomSalt(), salt);
                u.guest = true;
                s.users.add(u);
                return u;
            });
        }

        static User login(String rawUsername, String password) {
            String username = rawUsername.toLowerCase(Locale.ROOT);
            long[] fail = FAILS.get(username);
            
            if (fail != null && System.currentTimeMillis() - fail[1] > 5 * 60 * 1000) { 
                FAILS.remove(username); fail = null; 
            }
            if (fail != null && fail[0] >= 5) {
                throw new TooManyRequestsException("Too many failed attempts. Please wait a few minutes and try again.");
            }

            return Database.transactionWithResult(s -> {
                User match = s.users.stream()
                        .filter(u -> u.username.equals(username) || (u.emailVerified && u.email != null && u.email.equalsIgnoreCase(username)))
                        .findFirst()
                        .orElse(null);

                if (match == null || !CryptoUtils.constantTimeEquals(CryptoUtils.hashPassword(password, match.salt), match.passwordHash)) {
                    long[] rec = FAILS.computeIfAbsent(username, k -> new long[]{0, System.currentTimeMillis()});
                    rec[0]++;
                    throw new BadRequestException("Incorrect username or password.");
                }

                FAILS.remove(username);
                match.prevLogin = match.lastLogin; 
                match.lastLogin = Instant.now().toString();
                return match;
            });
        }

        static void setSessionCookie(HttpExchange x, long userId) {
            String token = CryptoUtils.newToken();
            SESSIONS.put(token, new Session(userId, System.currentTimeMillis() + SESSION_TTL_MS));
            x.getResponseHeaders().add("Set-Cookie", "sid=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (SESSION_TTL_MS / 1000));
        }

        static void clearSessionCookie(HttpExchange x) {
            String token = HttpUtils.cookie(x, "sid");
            if (token != null) SESSIONS.remove(token);
            x.getResponseHeaders().add("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
        }

        static Optional<User> currentUser(HttpExchange x) {
            String token = HttpUtils.cookie(x, "sid");
            if (token == null) return Optional.empty();
            
            Session sess = SESSIONS.get(token);
            if (sess == null || sess.expires < System.currentTimeMillis()) {
                if (sess != null) SESSIONS.remove(token);
                return Optional.empty();
            }
            return Database.read(s -> s.users.stream().filter(u -> u.id == sess.userId).findFirst());
        }

        static User requireAuth(HttpExchange x) {
            return currentUser(x).orElseThrow(() -> new UnauthorizedException("Please log in to continue."));
        }

        static User requireMember(HttpExchange x) {
            User u = requireAuth(x);
            if (u.guest) throw new ForbiddenException("Guest sessions can't change account details. Make an account to unlock this.");
            return u;
        }

        static User requireStaff(HttpExchange x) {
            User u = requireAuth(x);
            if (!Role.EMPLOYEE.value.equals(u.role) && !Role.ADMIN.value.equals(u.role)) {
                throw new ForbiddenException("Employee access required.");
            }
            return u;
        }
    }

    static class AccountService {
        static void updateProfile(State s, long userId, Map<String, String> form) {
            User u = Database.findUserInState(s, userId);
            String newName = form.containsKey("name") ? HttpUtils.field(form, "name", 2, 60) : u.name;
            String newUsername = u.username;
            
            if (form.containsKey("username")) {
                String requestedUsername = HttpUtils.field(form, "username", 3, 24).toLowerCase(Locale.ROOT);
                if (!requestedUsername.equals(u.username)) {
                    if (u.guest) throw new BadRequestException("Guest accounts can't change their username. Create a full account first.");
                    HttpUtils.validate(requestedUsername.matches("[a-z0-9_]+"), "Username may only use letters, numbers and underscores.");
                    if (s.users.stream().anyMatch(o -> o != u && o.username.equals(requestedUsername))) {
                        throw new BadRequestException("That username is already taken.");
                    }
                    newUsername = requestedUsername;
                }
            }
            u.name = newName; 
            u.username = newUsername;
        }

        static void changePassword(State s, long userId, Map<String, String> form) {
            User u = Database.findUserInState(s, userId);
            if (u.guest) throw new BadRequestException("Guest accounts don't have a password. Create a full account to set one.");
            
            String current = HttpUtils.req(form, "current");
            String next = HttpUtils.req(form, "password");
            
            if (!CryptoUtils.constantTimeEquals(CryptoUtils.hashPassword(current, u.salt), u.passwordHash)) {
                throw new BadRequestException("Your current password is incorrect.");
            }
            HttpUtils.validate(next.length() >= 6 && next.length() <= 100, "New password must be 6-100 characters.");
            HttpUtils.validate(!next.equals(current), "Choose a password different from your current one.");
            
            u.salt = CryptoUtils.randomSalt(); 
            u.passwordHash = CryptoUtils.hashPassword(next, u.salt);
        }

        static String setContact(State s, long userId, boolean isEmail, String value) {
            User u = Database.findUserInState(s, userId);
            String key = u.id + (isEmail ? ":email" : ":phone");
            
            if (value.isBlank()) {
                if (isEmail) { u.email = null; u.emailVerified = false; } 
                else { u.phone = null; u.phoneVerified = false; }
                PENDING.remove(key); 
                return null;
            }
            
            String target;
            if (isEmail) {
                target = value.trim().toLowerCase(Locale.ROOT);
                HttpUtils.validate(target.length() <= 120 && EMAIL_PATTERN.matcher(target).matches(), "Enter a valid email address.");
                if (s.users.stream().anyMatch(o -> o != u && o.emailVerified && target.equalsIgnoreCase(o.email))) {
                    throw new BadRequestException("That email is already used by another account.");
                }
                if (target.equals(u.email) && u.emailVerified) throw new BadRequestException("This email is already verified.");
                u.email = target; 
                u.emailVerified = false;
            } else {
                target = normalizePhone(value);
                if (s.users.stream().anyMatch(o -> o != u && o.phoneVerified && target.equals(o.phone))) {
                    throw new BadRequestException("That phone number is already used by another account.");
                }
                if (target.equals(u.phone) && u.phoneVerified) throw new BadRequestException("This number is already verified.");
                u.phone = target; 
                u.phoneVerified = false;
            }
            
            String code = String.format("%06d", new SecureRandom().nextInt(1_000_000));
            PENDING.put(key, new Pending(target, code, System.currentTimeMillis() + 10 * 60 * 1000));
            System.out.println("[DEMO] " + (isEmail ? "Email" : "SMS") + " verification code for " + target + " -> " + code);
            return code;
        }

        static void verifyContact(State s, long userId, boolean isEmail, String code) {
            User u = Database.findUserInState(s, userId);
            String key = u.id + (isEmail ? ":email" : ":phone");
            Pending p = PENDING.get(key);
            String current = isEmail ? u.email : u.phone;
            
            if (p == null || current == null || !p.target.equals(current)) throw new BadRequestException("No verification is pending. Request a new code first.");
            if (p.expires < System.currentTimeMillis()) { PENDING.remove(key); throw new BadRequestException("That code has expired. Request a new one."); }
            if (++p.attempts > 5) { PENDING.remove(key); throw new BadRequestException("Too many wrong attempts. Request a new code."); }
            
            if (!MessageDigest.isEqual(p.code.getBytes(StandardCharsets.UTF_8), code.getBytes(StandardCharsets.UTF_8))) {
                throw new BadRequestException("Incorrect code. Please try again.");
            }
            
            if (isEmail) u.emailVerified = true; else u.phoneVerified = true;
            PENDING.remove(key);
        }

        static void setAvatar(State s, long userId, String dataUrl) {
            User u = Database.findUserInState(s, userId);
            Matcher m = Pattern.compile("^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$").matcher(dataUrl);
            if (!m.matches()) throw new BadRequestException("Upload a PNG, JPG, WebP or GIF image.");
            
            byte[] img;
            try { 
                img = Base64.getDecoder().decode(m.group(2)); 
            } catch (IllegalArgumentException e) { 
                throw new BadRequestException("That image could not be read."); 
            }
            
            HttpUtils.validate(img.length >= 32 && img.length <= 300_000, "Profile picture must be under 300 KB.");
            
            boolean ok = (m.group(1).equals("image/png") && (img[0] & 0xFF) == 0x89 && img[1] == 'P')
                      || (m.group(1).equals("image/jpeg") && (img[0] & 0xFF) == 0xFF && (img[1] & 0xFF) == 0xD8)
                      || (m.group(1).equals("image/gif") && img[0] == 'G' && img[1] == 'I')
                      || (m.group(1).equals("image/webp") && img[0] == 'R' && img[1] == 'I');
                      
            if (!ok) throw new BadRequestException("That file doesn't look like a valid image.");
            
            u.avatar = img; 
            u.avatarMime = m.group(1); 
            u.avatarVer = System.currentTimeMillis();
        }

        static void addAddress(State s, long userId, Map<String, String> f) {
            User u = Database.findUserInState(s, userId);
            if (u.addr().size() >= 5) throw new BadRequestException("You can save up to 5 addresses. Delete one first.");
            
            Address a = new Address();
            a.id = ++u.nextAddress;
            a.label = HttpUtils.field(f, "label", 2, 30); 
            a.recipient = HttpUtils.field(f, "recipient", 2, 60);
            a.phone = normalizePhone(HttpUtils.req(f, "phone"));
            a.street = HttpUtils.field(f, "street", 5, 120); 
            a.city = HttpUtils.field(f, "city", 2, 60);
            u.addr().add(a);
        }

        private static String normalizePhone(String raw) {
            String v = raw.replaceAll("[\\s()-]", "");
            if (v.matches("09[0-9]{9}")) return "+63" + v.substring(1);
            if (v.matches("9[0-9]{9}")) return "+63" + v;
            if (v.matches("639[0-9]{9}")) return "+" + v;
            if (v.matches("\\+[1-9][0-9]{7,14}")) return v;
            throw new BadRequestException("Enter a valid mobile number, e.g. 09171234567 or +639171234567.");
        }
    }

    static class ProductService {
        static Product createProduct(State s, Map<String, String> f) {
            Product p = buildProductFromForm(s, f, s.nextProduct++, -1);
            s.products.add(p);
            return p;
        }

        static Product updateProduct(State s, long id, Map<String, String> f) {
            Product old = Database.findProductInState(s, id).orElseThrow(() -> new ResourceNotFoundException("Product not found"));
            Product updated = buildProductFromForm(s, f, id, id);
            updated.stock = old.stock;
            if (!f.containsKey("expiry")) updated.expiry = old.expiry == null ? "" : old.expiry;
            
            int index = s.products.indexOf(old);
            s.products.set(index, updated);
            return updated;
        }

        static Product updateExpiry(State s, long id, String expiryRaw) {
            Product p = Database.findProductInState(s, id).orElseThrow(() -> new ResourceNotFoundException("Product not found"));
            p.expiry = parseExpiry(expiryRaw);
            return p;
        }

        static Product updateStock(State s, long id, String changeRaw) {
            Product p = Database.findProductInState(s, id).orElseThrow(() -> new ResourceNotFoundException("Product not found"));
            int change = HttpUtils.integer(changeRaw, -100000, 100000);
            if (change == 0 || (long) p.stock + change < 0 || (long) p.stock + change > 1000000) {
                throw new BadRequestException("Invalid stock change.");
            }
            p.stock += change;
            return p;
        }

        private static Product buildProductFromForm(State s, Map<String, String> f, long id, long exceptId) {
            String name = HttpUtils.field(f, "name", 2, 80);
            String sku = HttpUtils.field(f, "sku", 2, 40);
            String category = HttpUtils.field(f, "category", 2, 40);
            String icon = f.getOrDefault("icon", "📦").trim();
            HttpUtils.validate(!icon.isEmpty() && icon.length() <= 500, "Choose a short product emoji or a valid image URL.");
            
            String description = f.getOrDefault("description", "").trim();
            HttpUtils.validate(description.length() <= 600, "Description must be 600 characters or fewer.");
            
            long price = HttpUtils.money(HttpUtils.req(f, "price"));
            HttpUtils.validate(price >= 1 && price <= 100000000, "Price must be between ₱0.01 and ₱1,000,000.");
            
            int threshold = HttpUtils.integer(HttpUtils.req(f, "threshold"), 0, 1000000);
            int stock = exceptId < 0 ? HttpUtils.integer(HttpUtils.req(f, "stock"), 0, 1000000) : 0;
            String expiry = parseExpiry(f.get("expiry"));
            
            if (s.products.stream().anyMatch(p -> p.id != exceptId && p.sku.equalsIgnoreCase(sku))) {
                throw new BadRequestException("This SKU is already used.");
            }
            return new Product(id, name, sku, category, icon, price, stock, threshold, description, expiry);
        }

        private static String parseExpiry(String raw) {
            String v = raw == null ? "" : raw.trim();
            if (v.isEmpty()) return "";
            try { 
                LocalDate d = LocalDate.parse(v);
                HttpUtils.validate(d.getYear() >= 2000 && d.getYear() <= 2100, "Expiration date must be between the years 2000 and 2100.");
                return d.toString();
            } catch (Exception e) { 
                throw new BadRequestException("Expiration date must be a valid date (YYYY-MM-DD)."); 
            }
        }
        
        static boolean isExpired(Product p) {
            if (p.expiry == null || p.expiry.isEmpty()) return false;
            try { return LocalDate.parse(p.expiry).isBefore(LocalDate.now()); } catch (Exception e) { return false; }
        }
    }

    static class OrderService {
        static Sale checkout(State s, User u, Map<String, String> f) {
            String rawItems = HttpUtils.req(f, "items");
            String[] entries = rawItems.split(",");
            HttpUtils.validate(entries.length >= 1 && entries.length <= 100, "Cart is empty or too large.");
            
            Set<Long> seen = new HashSet<>();
            ArrayList<Line> lines = new ArrayList<>();
            long total = 0;
            
            for (String entry : entries) {
                String[] pair = entry.split(":", -1);
                HttpUtils.validate(pair.length == 2, "Invalid cart.");
                
                long productId; 
                int qty;
                try { 
                    productId = Long.parseLong(pair[0]); 
                    qty = Integer.parseInt(pair[1]); 
                } catch (NumberFormatException e) { 
                    throw new BadRequestException("Invalid cart."); 
                }
                
                HttpUtils.validate(qty >= 1 && qty <= 10000 && seen.add(productId), "Invalid cart quantity.");
                
                Product p = Database.findProductInState(s, productId).orElseThrow(() -> new BadRequestException("Product no longer exists."));
                if (ProductService.isExpired(p)) throw new BadRequestException(p.name + " has passed its expiration date and can't be sold.");
                if (p.stock < qty) throw new BadRequestException(p.name + " only has " + p.stock + " in stock.");
                
                total = Math.addExact(total, Math.multiplyExact(p.price, qty));
                lines.add(new Line(p, qty));
            }
            
            boolean customer = Role.CUSTOMER.value.equals(u.role);
            String fulfillment = "in-store", payment = "cash", address = null, note = "";
            long fee = 0;
            
            if (customer) {
                fulfillment = f.getOrDefault("fulfillment", FulfillmentType.PICKUP.value);
                payment = f.getOrDefault("payment", PaymentMethod.COD.value);
                
                HttpUtils.validate(FulfillmentType.isValid(fulfillment), "Choose pickup or delivery.");
                HttpUtils.validate(PaymentMethod.isValid(payment), "Choose a payment method.");
                
                note = f.getOrDefault("note", "").trim();
                HttpUtils.validate(note.length() <= 200, "Order note must be 200 characters or fewer.");
                
                if (FulfillmentType.DELIVERY.value.equals(fulfillment)) {
                    long addressId;
                    try { addressId = Long.parseLong(HttpUtils.req(f, "addressId")); } 
                    catch (NumberFormatException e) { throw new BadRequestException("Choose a delivery address."); }
                    
                    Address a = u.addr().stream().filter(candidate -> candidate.id == addressId).findFirst().orElse(null);
                    if (a == null) throw new BadRequestException("Choose a delivery address.");
                    
                    address = a.recipient + " · " + a.phone + " · " + a.street + ", " + a.city;
                    fee = total >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEE;
                }
            }
            
            long due = total + fee;
            long paid;
            
            if (customer) {
                paid = due;
            } else {
                paid = HttpUtils.money(HttpUtils.req(f, "paid"));
                HttpUtils.validate(paid >= due, "Cash received is less than the total.");
                HttpUtils.validate(paid <= 1000000000, "Cash received is too large.");
            }
            
            // Deduct Stock
            for (Line line : lines) {
                Product p = Database.findProductInState(s, line.productId).orElseThrow();
                p.stock -= line.quantity;
            }
            
            Long customerId; 
            String buyerName, cashierName;
            
            if (customer) {
                customerId = u.id; 
                buyerName = u.name; 
                cashierName = null;
            } else {
                String walkIn = f.getOrDefault("customerName", "").trim();
                HttpUtils.validate(walkIn.length() <= 80, "Customer name is too long.");
                customerId = null; 
                buyerName = walkIn.isEmpty() ? "Walk-in customer" : walkIn; 
                cashierName = u.name;
            }
            
            Sale sale = new Sale(s.nextSale++, due, paid, lines, customerId, buyerName, cashierName);
            sale.cashierId = customer ? null : u.id;
            sale.status = customer ? OrderStatus.PENDING.value : OrderStatus.COMPLETED.value;
            sale.updated = sale.time;
            sale.fulfillment = fulfillment; 
            sale.payment = payment; 
            sale.address = address; 
            sale.note = note; 
            sale.fee = fee;
            s.sales.add(sale);
            return sale;
        }

        static Sale updateStatus(State s, User u, long id, String status) {
            HttpUtils.validate(OrderStatus.isValid(status), "Unknown order status.");
            Sale sale = s.sales.stream().filter(a -> a.id == id).findFirst().orElseThrow(() -> new BadRequestException("Order not found."));
            
            boolean staff = Role.EMPLOYEE.value.equals(u.role) || Role.ADMIN.value.equals(u.role);
            if (!staff && (sale.customerId == null || sale.customerId != u.id)) {
                throw new ForbiddenException("That is not your order.");
            }
            
            String current = sale.status == null ? OrderStatus.COMPLETED.value : sale.status;
            if (OrderStatus.COMPLETED.value.equals(current) || OrderStatus.CANCELLED.value.equals(current)) {
                throw new BadRequestException("This order is already closed.");
            }
            
            if (!staff) {
                HttpUtils.validate(OrderStatus.CANCELLED.value.equals(status), "Only the store can update order progress.");
                HttpUtils.validate(OrderStatus.PENDING.value.equals(current), "The store is already preparing this order. Please contact the store to cancel.");
            }
            
            if (OrderStatus.OUT_FOR_DELIVERY.value.equals(status) && !FulfillmentType.DELIVERY.value.equals(sale.fulfillment)) {
                throw new BadRequestException("Only delivery orders can be sent out for delivery.");
            }
            if (OrderStatus.READY.value.equals(status) && !FulfillmentType.PICKUP.value.equals(sale.fulfillment)) {
                throw new BadRequestException("Only pickup orders can be marked ready for pickup.");
            }
            
            if (OrderStatus.CANCELLED.value.equals(status)) {
                for (Line l : sale.lines) {
                    Database.findProductInState(s, l.productId).ifPresent(p -> p.stock += l.quantity);
                }
            }
            
            sale.status = status; 
            sale.updated = Instant.now().toString();
            return sale;
        }
    }

    // =========================================================================================
    // 3. UTILITIES & EXCEPTIONS
    // =========================================================================================

    static class HttpUtils {
        static Map<String, String> parseForm(HttpExchange x) throws IOException { return parseForm(x, 65536); }
        static Map<String, String> parseForm(HttpExchange x, int limit) throws IOException {
            byte[] body = x.getRequestBody().readNBytes(limit + 1);
            if (body.length > limit) throw new BadRequestException("Request too large.");
            Map<String, String> params = new HashMap<>();
            for (String pair : new String(body, StandardCharsets.UTF_8).split("&")) {
                if (pair.isEmpty()) continue;
                String[] part = pair.split("=", 2);
                params.put(URLDecoder.decode(part[0], StandardCharsets.UTF_8), URLDecoder.decode(part.length == 2 ? part[1] : "", StandardCharsets.UTF_8));
            }
            return params;
        }

        static void respondJson(HttpExchange x, int status, String json) throws IOException {
            respondBytes(x, status, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
        }

        static void respondBytes(HttpExchange x, int status, String contentType, byte[] bytes) throws IOException {
            x.getResponseHeaders().set("Content-Type", contentType);
            x.getResponseHeaders().set("Cache-Control", contentType.contains("image/") ? "public, max-age=300" : "no-store");
            x.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
            x.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = x.getResponseBody()) { out.write(bytes); }
        }

        static String cookie(HttpExchange x, String name) {
            String header = x.getRequestHeaders().getFirst("Cookie");
            if (header == null) return null;
            for (String part : header.split(";")) {
                String[] kv = part.trim().split("=", 2);
                if (kv.length == 2 && kv[0].equals(name)) return kv[1];
            }
            return null;
        }

        static String req(Map<String, String> f, String key) {
            String value = f.get(key);
            if (value == null || value.isBlank()) throw new BadRequestException("Missing " + key + ".");
            return value.trim();
        }

        static String field(Map<String, String> f, String key, int min, int max) {
            String value = req(f, key);
            validate(value.length() >= min && value.length() <= max, key + " must have " + min + " to " + max + " characters.");
            return value;
        }

        static int integer(String rawValue, int min, int max) {
            try {
                int n = Integer.parseInt(rawValue);
                if (n < min || n > max) throw new NumberFormatException();
                return n;
            } catch (NumberFormatException e) { throw new BadRequestException("Invalid number format."); }
        }

        static long money(String value) {
            try { return new BigDecimal(value).movePointRight(2).longValueExact(); }
            catch (Exception e) { throw new BadRequestException("Enter a valid peso amount with up to 2 decimal places."); }
        }

        static void validate(boolean condition, String message) {
            if (!condition) throw new BadRequestException(message);
        }
    }

    static class CryptoUtils {
        static String randomSalt() {
            byte[] b = new byte[16]; new SecureRandom().nextBytes(b);
            return Base64.getEncoder().encodeToString(b);
        }

        static String hashPassword(String password, String saltB64) {
            try {
                byte[] salt = Base64.getDecoder().decode(saltB64);
                PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, 65536, 256);
                SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
                return Base64.getEncoder().encodeToString(f.generateSecret(spec).getEncoded());
            } catch (Exception e) { throw new RuntimeException(e); }
        }

        static boolean constantTimeEquals(String a, String b) {
            try { return MessageDigest.isEqual(Base64.getDecoder().decode(a), Base64.getDecoder().decode(b)); }
            catch (Exception e) { return false; }
        }

        static String newToken() {
            byte[] b = new byte[24]; new SecureRandom().nextBytes(b);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        }
    }

    static class JsonMapper {
        static String quote(String value) {
            if (value == null) return "null";
            StringBuilder b = new StringBuilder("\"");
            for (char c : value.toCharArray()) {
                switch (c) {
                    case '"' -> b.append("\\\""); case '\\' -> b.append("\\\\");
                    case '\n' -> b.append("\\n"); case '\r' -> b.append("\\r"); case '\t' -> b.append("\\t");
                    default -> { if (c < 32) b.append(String.format("\\u%04x", (int) c)); else b.append(c); }
                }
            }
            return b.append('"').toString();
        }

        static String toJson(User u) {
            return """
                {"id":%d,"username":%s,"name":%s,"role":%s,"email":%s,"emailVerified":%b,"phone":%s,"phoneVerified":%b,"avatarVer":%d,"guest":%b,"createdAt":%s}"""
                .formatted(u.id, quote(u.username), quote(u.name), quote(u.role),
                           u.email == null ? "null" : quote(u.email), u.emailVerified,
                           u.phone == null ? "null" : quote(u.phone), u.phoneVerified,
                           u.avatar == null ? 0 : u.avatarVer, u.guest, quote(u.createdAt));
        }

        static String toJson(Product p) {
            return """
                {"id":%d,"name":%s,"sku":%s,"category":%s,"icon":%s,"price":%d,"stock":%d,"threshold":%d,"description":%s,"expiry":%s}"""
                .formatted(p.id, quote(p.name), quote(p.sku), quote(p.category), quote(p.icon), p.price, p.stock, p.threshold,
                           quote(p.description == null ? "" : p.description), quote(p.expiry == null ? "" : p.expiry));
        }

        static String toJson(Sale s) {
            String linesJson = s.lines.stream().map(l -> """
                {"productId":%d,"name":%s,"price":%d,"quantity":%d}"""
                .formatted(l.productId, quote(l.name), l.price, l.quantity)).collect(Collectors.joining(",", "[", "]"));
            return """
                {"id":%d,"time":%s,"total":%d,"paid":%d,"change":%d,"customerId":%s,"buyerName":%s,"cashierName":%s,"status":%s,"fulfillment":%s,"payment":%s,"address":%s,"note":%s,"fee":%d,"updated":%s,"lines":%s}"""
                .formatted(s.id, quote(s.time), s.total, s.paid, (s.paid - s.total),
                           s.customerId == null ? "null" : s.customerId, quote(s.buyerName),
                           s.cashierName == null ? "null" : quote(s.cashierName),
                           quote(s.status == null ? OrderStatus.COMPLETED.value : s.status),
                           quote(s.fulfillment == null ? FulfillmentType.IN_STORE.value : s.fulfillment),
                           quote(s.payment == null ? PaymentMethod.CASH.value : s.payment),
                           s.address == null ? "null" : quote(s.address),
                           quote(s.note == null ? "" : s.note), s.fee,
                           s.updated == null ? "null" : quote(s.updated), linesJson);
        }

        static String toJsonAddresses(User u) {
            return u.addr().stream().map(a -> """
                {"id":%d,"label":%s,"recipient":%s,"phone":%s,"street":%s,"city":%s}"""
                .formatted(a.id, quote(a.label), quote(a.recipient), quote(a.phone), quote(a.street), quote(a.city)))
                .collect(Collectors.joining(",", "[", "]"));
        }

        static String toJsonWishlist(User u) {
            return u.wl().stream().map(String::valueOf).collect(Collectors.joining(",", "[", "]"));
        }

        static String toJsonAccount(State s, User u) {
            boolean staff = Role.EMPLOYEE.value.equals(u.role) || Role.ADMIN.value.equals(u.role);
            long orders = 0, cancelled = 0, spent = 0, items = 0, today = 0;
            String last = null; 
            Map<String, Integer> byName = new HashMap<>();
            String todayStr = Instant.now().toString().substring(0, 10);
            
            for (Sale sale : s.sales) {
                boolean mine = staff
                    ? (sale.cashierId != null ? sale.cashierId == u.id : sale.cashierName != null && sale.cashierName.equals(u.name))
                    : sale.customerId != null && sale.customerId == u.id;
                
                if (!mine) continue;
                if (OrderStatus.CANCELLED.value.equals(sale.status)) { cancelled++; continue; }
                
                orders++; spent += sale.total;
                if (sale.time.startsWith(todayStr)) today++;
                for (Line l : sale.lines) { items += l.quantity; byName.merge(l.name, l.quantity, Integer::sum); }
                if (last == null || sale.time.compareTo(last) > 0) last = sale.time;
            }
            
            String top = byName.entrySet().stream().max(Map.Entry.comparingByValue()).map(Map.Entry::getKey).orElse(null);
            long sessions = SESSIONS.values().stream().filter(v -> v.userId == u.id && v.expires > System.currentTimeMillis()).count();
            
            return """
                {"user":%s,"staff":%b,"sessions":%d,"lastLogin":%s,"stats":{"orders":%d,"cancelled":%d,"spent":%d,"items":%d,"today":%d,"average":%d,"lastOrder":%s,"topProduct":%s,"wishlist":%d,"addresses":%d}}"""
                .formatted(toJson(u), staff, sessions, u.prevLogin == null ? "null" : quote(u.prevLogin),
                           orders, cancelled, spent, items, today, orders == 0 ? 0 : spent / orders,
                           last == null ? "null" : quote(last), top == null ? "null" : quote(top),
                           u.wl().size(), u.addr().size());
        }

        static String toJsonState(State s, User viewer) {
            String productsJson = s.products.stream().map(JsonMapper::toJson).collect(Collectors.joining(",", "[", "]"));
            boolean staff = Role.EMPLOYEE.value.equals(viewer.role) || Role.ADMIN.value.equals(viewer.role);
            
            List<Sale> filteredSales = new ArrayList<>();
            for (int i = s.sales.size() - 1; i >= 0; i--) {
                Sale sale = s.sales.get(i);
                if (staff || (sale.customerId != null && sale.customerId == viewer.id)) filteredSales.add(sale);
            }
            String salesJson = filteredSales.stream().map(JsonMapper::toJson).collect(Collectors.joining(",", "[", "]"));
            
            return """
                {"me":%s,"products":%s,"%s":%s,"wishlist":%s,"addresses":%s,"config":{"deliveryFee":%d,"freeDeliveryOver":%d}}"""
                .formatted(toJson(viewer), productsJson, staff ? "sales" : "myOrders", salesJson,
                           toJsonWishlist(viewer), toJsonAddresses(viewer), DELIVERY_FEE, FREE_DELIVERY_OVER);
        }
    }

    abstract static class DomainException extends RuntimeException {
        final int status;
        DomainException(int status, String msg) { super(msg); this.status = status; }
    }
    static class BadRequestException extends DomainException { BadRequestException(String msg) { super(400, msg); } }
    static class UnauthorizedException extends DomainException { UnauthorizedException(String msg) { super(401, msg); } }
    static class ForbiddenException extends DomainException { ForbiddenException(String msg) { super(403, msg); } }
    static class ResourceNotFoundException extends DomainException { ResourceNotFoundException(String msg) { super(404, msg); } }
    static class TooManyRequestsException extends DomainException { TooManyRequestsException(String msg) { super(429, msg); } }

    enum Role { CUSTOMER("customer"), EMPLOYEE("employee"), ADMIN("admin"); final String value; Role(String v) { this.value = v; } }
    enum OrderStatus { 
        PENDING("pending"), PREPARING("preparing"), OUT_FOR_DELIVERY("out_for_delivery"), READY("ready"), COMPLETED("completed"), CANCELLED("cancelled"); 
        final String value; OrderStatus(String v) { this.value = v; }
        static boolean isValid(String v) { return Arrays.stream(values()).anyMatch(e -> e.value.equals(v)); }
    }
    enum FulfillmentType { 
        IN_STORE("in-store"), PICKUP("pickup"), DELIVERY("delivery"); 
        final String value; FulfillmentType(String v) { this.value = v; }
        static boolean isValid(String v) { return Arrays.stream(values()).anyMatch(e -> e.value.equals(v)); }
    }
    enum PaymentMethod { 
        CASH("cash"), COD("cod"), GCASH("gcash"), CARD("card"); 
        final String value; PaymentMethod(String v) { this.value = v; }
        static boolean isValid(String v) { return Arrays.stream(values()).anyMatch(e -> e.value.equals(v)); }
    }


    // =========================================================================================
    // 4. PERSISTENCE & DATABASE
    // =========================================================================================

    static class Database {
        private static final Object DB_LOCK = new Object();
        private static final Path DATA_PATH = Path.of("data", "storeflow.dat");
        private static State rootState;

        static void initialize() throws Exception {
            synchronized (DB_LOCK) {
                if (Files.exists(DATA_PATH)) {
                    try (ObjectInputStream input = new ObjectInputStream(Files.newInputStream(DATA_PATH))) {
                        rootState = (State) input.readObject();
                    }
                    backfillDescriptions(rootState);
                } else {
                    rootState = seedDatabase();
                    persist(rootState);
                }
            }
        }

        static <T> T read(java.util.function.Function<State, T> operation) {
            synchronized (DB_LOCK) {
                return operation.apply(rootState);
            }
        }

        static void transaction(Consumer<State> operation) {
            transactionWithResult(s -> { operation.accept(s); return null; });
        }

        static <T> T transactionWithResult(java.util.function.Function<State, T> operation) {
            synchronized (DB_LOCK) {
                State copy = copyState(rootState);
                T result = operation.apply(copy);
                try {
                    persist(copy);
                    rootState = copy;
                    return result;
                } catch (IOException e) {
                    throw new RuntimeException("Failed to persist state", e);
                }
            }
        }

        static User findUser(long id) {
            return read(s -> findUserInState(s, id));
        }

        static User findUserInState(State s, long id) {
            return s.users.stream().filter(u -> u.id == id).findFirst().orElseThrow(() -> new ResourceNotFoundException("User not found"));
        }

        static Optional<Product> findProductInState(State s, long id) {
            return s.products.stream().filter(p -> p.id == id).findFirst();
        }

        private static void persist(State s) throws IOException {
            Files.createDirectories(DATA_PATH.getParent());
            Path temp = DATA_PATH.resolveSibling("storeflow.dat.tmp");
            try (ObjectOutputStream out = new ObjectOutputStream(Files.newOutputStream(temp))) { out.writeObject(s); }
            try { Files.move(temp, DATA_PATH, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException e) { Files.move(temp, DATA_PATH, StandardCopyOption.REPLACE_EXISTING); }
        }

        private static State copyState(State source) {
            State s = new State();
            s.nextProduct = source.nextProduct; s.nextSale = source.nextSale; s.nextUser = source.nextUser;
            for (Product p : source.products) s.products.add(new Product(p.id, p.name, p.sku, p.category, p.icon, p.price, p.stock, p.threshold, p.description, p.expiry));
            s.sales.addAll(source.sales);
            s.users.addAll(source.users);
            return s;
        }

        private static void backfillDescriptions(State s) {
            Map<String, String> descMap = getSeedDescriptions();
            for (Product p : s.products) {
                if (p.description == null) p.description = descMap.getOrDefault(p.sku, "");
            }
        }

        private static State seedDatabase() {
            State s = new State();
            Map<String, String> descMap = getSeedDescriptions();
            s.products.add(new Product(s.nextProduct++, "Iced Caramel Latte", "SF-001", "Beverages", "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=400&q=80", 15900, 40, 10, descMap.get("SF-001"), ""));
            s.products.add(new Product(s.nextProduct++, "Classic Cheeseburger", "SF-002", "Hot Foods", "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80", 18500, 25, 5, descMap.get("SF-002"), ""));
            
            String salt = CryptoUtils.randomSalt();
            s.users.add(new User(s.nextUser++, "admin", "Store Admin", Role.ADMIN.value, CryptoUtils.hashPassword("admin123", salt), salt));
            salt = CryptoUtils.randomSalt();
            s.users.add(new User(s.nextUser++, "cashier", "Jamie Cruz", Role.EMPLOYEE.value, CryptoUtils.hashPassword("cashier123", salt), salt));
            return s;
        }

        private static Map<String, String> getSeedDescriptions() {
            Map<String, String> m = new HashMap<>();
            m.put("SF-001", "Cold-brewed espresso shaken over ice with silky milk and a ribbon of house-made caramel. Sweet, smooth and made to order.");
            m.put("SF-002", "A juicy beef patty with melted cheddar, crisp lettuce, tomato and pickles on a toasted brioche bun. Served hot off the grill.");
            return m;
        }
    }

    // =========================================================================================
    // 5. DOMAIN MODELS
    // Note: These classes are kept structurally identical to the original to preserve backwards
    // compatibility with the existing `storeflow.dat` ObjectInputStream serialized format.
    // =========================================================================================

    static class User implements Serializable {
        private static final long serialVersionUID = 1L;
        long id;
        String username, name, role; 
        String passwordHash, salt, createdAt;
        String email, phone, lastLogin, prevLogin, avatarMime;
        boolean emailVerified, phoneVerified, guest;
        byte[] avatar;
        long avatarVer, nextAddress;
        ArrayList<Long> wishlist;
        ArrayList<Address> addresses;

        User(long id, String username, String name, String role, String passwordHash, String salt) {
            this.id = id; this.username = username; this.name = name; this.role = role;
            this.passwordHash = passwordHash; this.salt = salt;
            this.createdAt = Instant.now().toString();
            this.lastLogin = this.createdAt;
        }
        ArrayList<Long> wl() { if (wishlist == null) wishlist = new ArrayList<>(); return wishlist; }
        ArrayList<Address> addr() { if (addresses == null) addresses = new ArrayList<>(); return addresses; }
    }

    static class Address implements Serializable {
        private static final long serialVersionUID = 1L;
        long id;
        String label, recipient, phone, street, city;
    }

    static class Product implements Serializable {
        private static final long serialVersionUID = 1L;
        long id;
        String name, sku, category, icon;
        String description; 
        String expiry;      
        long price;
        int stock, threshold;

        Product(long id, String name, String sku, String category, String icon, long price, int stock, int threshold, String description, String expiry) {
            this.expiry = expiry == null ? "" : expiry;
            this.description = description == null ? "" : description;
            this.id = id; this.name = name; this.sku = sku; this.category = category; this.icon = icon;
            this.price = price; this.stock = stock; this.threshold = threshold;
        }
    }

    static class Line implements Serializable {
        private static final long serialVersionUID = 1L;
        long productId, price;
        String name;
        int quantity;
        Line(Product p, int qty) { productId = p.id; name = p.name; price = p.price; quantity = qty; }
    }

    static class Sale implements Serializable {
        private static final long serialVersionUID = 1L;
        long id, total, paid;
        Long customerId; 
        String buyerName, cashierName; 
        String time;
        ArrayList<Line> lines;
        Long cashierId;
        String status, fulfillment, payment, address, note, updated;
        long fee;

        Sale(long id, long total, long paid, ArrayList<Line> lines, Long customerId, String buyerName, String cashierName) {
            this.id = id; this.total = total; this.paid = paid; this.lines = lines;
            this.customerId = customerId; this.buyerName = buyerName; this.cashierName = cashierName;
            this.time = Instant.now().toString();
        }
    }

    static class State implements Serializable {
        private static final long serialVersionUID = 1L;
        long nextProduct = 1, nextSale = 1, nextUser = 1;
        ArrayList<Product> products = new ArrayList<>();
        ArrayList<Sale> sales = new ArrayList<>();
        ArrayList<User> users = new ArrayList<>();
    }

    static class Pending {
        final String target, code; final long expires; int attempts;
        Pending(String target, String code, long expires) { this.target = target; this.code = code; this.expires = expires; }
    }

    static class Session {
        long userId, expires;
        Session(long userId, long expires) { this.userId = userId; this.expires = expires; }
    }
}