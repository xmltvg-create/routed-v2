#!/usr/bin/env python3

import httpx
import asyncio
import json
import io
import pandas as pd

# Backend API URL from frontend/.env
BACKEND_URL = "https://route-opt.preview.emergentagent.com/api"

class TestImportAddressPreservation:
    """Test suite specifically for XLS/CSV import address preservation bug fix"""
    
    def __init__(self):
        self.session_token = None
        self.http_client = httpx.AsyncClient(timeout=30.0)
    
    async def setup_auth_session(self):
        """Setup DEV_MODE authentication session"""
        try:
            print("🔑 DEV_MODE enabled - no authentication required...")
            # In DEV_MODE, no session token is needed as auth is bypassed
            self.session_token = "dev-mode-no-auth-needed"
            print(f"✅ DEV_MODE session ready")
            return True
        except Exception as e:
            print(f"❌ Session setup error: {e}")
            return False
    
    async def verify_auth(self):
        """Verify authentication works"""
        try:
            # In DEV_MODE, no auth headers needed
            print("🔑 DEV_MODE - authentication bypassed automatically")
            response = await self.http_client.get(f"{BACKEND_URL}/health")
            if response.status_code == 200:
                print(f"✅ Backend connection verified - Health check passed")
                return True
            else:
                print(f"❌ Backend connection failed: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ Backend connection error: {e}")
            return False
    
    def create_test_csv_content(self):
        """Create CSV content with the specific test address"""
        # Using the exact address from the review request
        test_data = {
            "Delivery Address": ["UNIT 164 PALM LAKE RESORT 96 VILLAGE WAY LITTLE MOUNTAIN QLD 4551 Australia"],
            "Customer Name": ["Palm Lake Resort Delivery"],
            "Mobile": ["0412345678"],
            "Notes": ["Unit 164 delivery - Resort reception"]
        }
        
        df = pd.DataFrame(test_data)
        csv_buffer = io.StringIO()
        df.to_csv(csv_buffer, index=False)
        return csv_buffer.getvalue()
    
    async def test_import_process_address_preservation(self):
        """Test the main bug fix: address preservation during CSV/XLS import"""
        try:
            print("\n🧪 Testing CSV/XLS import address preservation...")
            
            # Create test CSV content
            csv_content = self.create_test_csv_content()
            print(f"📄 Created test CSV with address: 'UNIT 164 PALM LAKE RESORT 96 VILLAGE WAY LITTLE MOUNTAIN QLD 4551 Australia'")
            
            # Define field mapping - maps CSV columns to stop fields
            field_mapping = {
                "address": "Delivery Address",
                "name": "Customer Name", 
                "mobile_number": "Mobile",
                "notes": "Notes"
            }
            
            # Prepare multipart form data
            files = {
                "file": ("test_import.csv", csv_content, "text/csv")
            }
            data = {
                "mapping": json.dumps(field_mapping),
                "clear_existing": "true"
            }
            headers = {"Authorization": f"Bearer {self.session_token}"}
            
            # Make import request
            response = await self.http_client.post(
                f"{BACKEND_URL}/import/process",
                files=files,
                data=data
                # No auth headers needed in DEV_MODE
            )
            
            if response.status_code == 200:
                result = response.json()
                print(f"✅ Import successful - Created {result.get('success_count')} stops")
                
                # Verify the imported stop data
                if result.get('success_count') > 0 and 'stops' in result:
                    stop = result['stops'][0]
                    original_address = "UNIT 164 PALM LAKE RESORT 96 VILLAGE WAY LITTLE MOUNTAIN QLD 4551 Australia"
                    
                    # KEY TEST: Verify address preservation
                    if stop.get('address') == original_address:
                        print(f"✅ CRITICAL TEST PASSED: Address preserved exactly as: '{stop.get('address')}'")
                    else:
                        print(f"❌ CRITICAL TEST FAILED: Address changed from '{original_address}' to '{stop.get('address')}'")
                        return False
                    
                    # Verify geocode metadata is stored separately
                    geocode_metadata = stop.get('geocode_metadata', {})
                    if 'geocoded_formatted_address' in geocode_metadata:
                        formatted_addr = geocode_metadata['geocoded_formatted_address']
                        print(f"✅ Geocoded formatted address stored separately: '{formatted_addr}'")
                    else:
                        print(f"⚠️ Warning: geocoded_formatted_address not found in metadata")
                    
                    if 'import_original_address' in geocode_metadata:
                        import_orig = geocode_metadata['import_original_address'] 
                        if import_orig == original_address:
                            print(f"✅ Import original address preserved in metadata: '{import_orig}'")
                        else:
                            print(f"❌ Import original address mismatch in metadata")
                    
                    # Show full stop data for verification
                    print(f"\n📊 Stop data summary:")
                    print(f"  • Address: {stop.get('address')}")
                    print(f"  • Name: {stop.get('name')}")
                    print(f"  • Mobile: {stop.get('mobile_number')}")
                    print(f"  • Latitude: {stop.get('latitude')}")
                    print(f"  • Longitude: {stop.get('longitude')}")
                    print(f"  • Geocoded formatted: {geocode_metadata.get('geocoded_formatted_address')}")
                    
                    return True
                else:
                    print(f"❌ No stops were created in import")
                    return False
            else:
                print(f"❌ Import failed: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            print(f"❌ Import test error: {e}")
            return False
    
    async def test_persisted_address_via_get_stops(self):
        """Verify the address is correctly persisted by fetching via GET /api/stops"""
        try:
            print("\n🔍 Testing persisted address via GET /api/stops...")
            
            # In DEV_MODE, no auth headers needed
            response = await self.http_client.get(f"{BACKEND_URL}/stops")
            
            if response.status_code == 200:
                stops = response.json()
                if len(stops) > 0:
                    stop = stops[0]
                    original_address = "UNIT 164 PALM LAKE RESORT 96 VILLAGE WAY LITTLE MOUNTAIN QLD 4551 Australia"
                    
                    # Verify persisted address matches original
                    if stop.get('address') == original_address:
                        print(f"✅ PERSISTENCE TEST PASSED: Address correctly persisted as: '{stop.get('address')}'")
                        
                        # Verify geocode metadata is also persisted
                        geocode_metadata = stop.get('geocode_metadata', {})
                        if geocode_metadata:
                            print(f"✅ Geocode metadata persisted with keys: {list(geocode_metadata.keys())}")
                            formatted_addr = geocode_metadata.get('geocoded_formatted_address')
                            if formatted_addr:
                                print(f"✅ Geocoded formatted address persisted: '{formatted_addr}'")
                        
                        return True
                    else:
                        print(f"❌ PERSISTENCE TEST FAILED: Address changed to: '{stop.get('address')}'")
                        return False
                else:
                    print(f"❌ No stops found in GET /api/stops")
                    return False
            else:
                print(f"❌ Failed to get stops: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            print(f"❌ Persistence test error: {e}")
            return False
    
    async def cleanup(self):
        """Clean up test data"""
        try:
            print("\n🧹 Cleaning up test data...")
            # In DEV_MODE, no auth headers needed
            response = await self.http_client.delete(f"{BACKEND_URL}/stops")
            if response.status_code == 200:
                result = response.json()
                print(f"✅ Cleanup complete - Deleted {result.get('deleted_count', 0)} stops")
        except Exception as e:
            print(f"⚠️ Cleanup error: {e}")
        
        await self.http_client.aclose()

async def run_import_address_preservation_tests():
    """Run comprehensive tests for CSV/XLS import address preservation"""
    print("🚀 Starting CSV/XLS Import Address Preservation Tests")
    print("=" * 70)
    
    test_suite = TestImportAddressPreservation()
    
    # Setup authentication
    if not await test_suite.setup_auth_session():
        print("❌ Test suite failed - Could not setup authentication")
        return False
    
    if not await test_suite.verify_auth():
        print("❌ Test suite failed - Authentication verification failed") 
        return False
    
    # Run the main tests
    test_results = []
    
    # Test 1: Import process with address preservation
    result1 = await test_suite.test_import_process_address_preservation()
    test_results.append(("Import Address Preservation", result1))
    
    # Test 2: Verify persistence via GET endpoint  
    result2 = await test_suite.test_persisted_address_via_get_stops()
    test_results.append(("Address Persistence Verification", result2))
    
    # Cleanup
    await test_suite.cleanup()
    
    # Summary
    print("\n" + "=" * 70)
    print("📋 TEST RESULTS SUMMARY")
    print("=" * 70)
    
    passed = 0
    failed = 0
    for test_name, passed_test in test_results:
        status = "✅ PASSED" if passed_test else "❌ FAILED"
        print(f"  {test_name}: {status}")
        if passed_test:
            passed += 1
        else:
            failed += 1
    
    print(f"\nOverall: {passed} passed, {failed} failed")
    
    if failed == 0:
        print("\n🎉 ALL TESTS PASSED - Address preservation bug fix is working correctly!")
        return True
    else:
        print(f"\n⚠️ {failed} test(s) failed - Address preservation needs attention")
        return False

if __name__ == "__main__":
    success = asyncio.run(run_import_address_preservation_tests())
    exit(0 if success else 1)