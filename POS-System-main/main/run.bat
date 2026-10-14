@echo off
cd /d "%~dp0"
if not defined STOREFLOW_PORT set STOREFLOW_PORT=8080
echo Starting 7/11 Online Convenience Store...
echo Demo employee logins: admin / admin123  and  cashier / cashier123
java src\StoreFlowServer.java
pause
