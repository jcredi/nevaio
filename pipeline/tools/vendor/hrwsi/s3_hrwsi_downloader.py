################################################################################
# Python client for S3 access to Copernicus Land Monitoring Service -
# High Resolution Water Snow and Ice (HR-WSI) data
################################################################################
#
# Publication date 2025-03-18
# License: CC-BY (not decided yet)
# Script Version 1.0
# Contact: https://land.copernicus.eu/en/contact-service-helpdesk
# 
# Requirements: Python Version 3
# Packages: see imports below
#
################################################################################
#
# This Python script allows you to do S3 queries to the Copernicus Land
# Monitoring Service (CLMS) High Resolution-Water, Snow & Ice (HR-WSI) portfolio.
# It foresees capabilities for search and download CLMS products
# (currently only the Near Real Time products of HR-WSI). Users are recommended
# to rely on this Python script, to perform custom and automatic queries.
#
################################################################################
# Legal notice about Copernicus data:
#
# Access to data is based on a principle of full, open and free access as
# established by the Copernicus data and information policy Regulation (EU)
# No 1159/2013 of 12 July 2013. This regulation establishes registration and
# licensing conditions for GMES/Copernicus users and can be found here:
# http://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32013R1159.
#
# Free, full and open access to this data set is made on the conditions that:
#
# 1. When distributing or communicating Copernicus dedicated data and Copernicus
#    service information to the public, users shall inform the public of the
#    source of that data and information.
# 2. Users shall make sure not to convey the impression to the public that the
#    user's activities are officially endorsed by the Union.
# 3. Where that data or information has been adapted or modified, the user shall
#    clearly state this.
# 4. The data remain the sole property of the European Union. Any information and
#    data produced in the framework of the action shall be the sole property of
#    the European Union. Any communication and publication by the beneficiary
#    shall acknowledge that the data were produced "with funding by the European
#    Union".
#
################################################################################




import os
import re
import sys
import logging
import datetime
import argparse
from pathlib import Path
from retry import retry
import boto3
from botocore.exceptions import ClientError, EndpointConnectionError
from tqdm import tqdm
from shapely import GEOSException
import geopandas as gpd
from pyproj.crs import CRSError
from pyogrio.errors import DataSourceError




class HRWSIRequest(object):
    '''
    Request HRWSI products in the catalogue.     
    '''

    #CATALOGUE URL
    ENDPOINT_URL="https://s3.WAW3-2.cloudferro.com"

    #ACCESS KEYS
    ACCESS_KEY='c4ae60af7b144053803c618a8860f7c9'
    SECRET_KEY='dcb3ba1f6eab45aaaec5802feef5e2e4'

    #CATALOGUE BUCKET WHERE THE DATA IS
    BUCKET="HRWSI"

    #DOWNLOAD THRESHOLD ABOVE WHICH DOWNLOADS WILL NOT START
    DOWNLOAD_THRESHOLD=500

    #DATE FORMAT
    DATE_FORMAT = '%Y-%m-%d'

    #TILE FORMAT
    TILE_FORMAT = 'T##XXX or ##XXX'

    #LIST OF YEARLY PRODUCT TYPES
    LIST_YEARLY = ["SP_S2","SP_S1S2","WCD","ICD"]

    #RESULT DIR
    RESULT_DIR = 'result'

    # start and end dates pf the search window
    START_DATE = 'start_date'
    END_DATE = 'end_date'

    # HRWSI product  T32TLR
    TILES = 'tiles'

    # MGRS TILES
    MGRS_TILES = "mgrs"

    # MGRS TILES GPKG
    MGRS_FILE = os.path.join(
        os.path.realpath(
            os.path.join(
                os.getcwd(),
                os.path.dirname(__file__))),
        'MGRS_tiles.gpkg')

    # parameter : HRWSI product type (FSC|SWS|GFSC|WDS|WIC_S1|WIC_S2|WIC_S1S2|CC|SP_S2|SP_S1S2|ICD|WCD).
    PRODUCT_TYPE = 'productType'

    def __init__(self, outputPath):
        self.outputPath = os.path.abspath(outputPath)
        if not os.path.exists(self.outputPath):
            logging.info("Creating directory " + self.outputPath)
            os.makedirs(self.outputPath)
        else:
            logging.warning("Existing directory " + self.outputPath)

        self.query_file = None

    def validate_product_type(self,product_type):
        '''
        Makes sure that the product type exists in the HRWSI catalogue
        Informs the frequency of the product type : daily (d), monthly (m) or 
        '''
        valid = False
        for _ in self.s3_client.Bucket(HRWSIRequest.BUCKET).objects.filter(Prefix=product_type+"/"):
            valid = True
            break

        if not valid:
            logging.error(f"-productType : {product_type} does not exist")
            sys.exit("-2")

        return product_type

    def validate_dates(self,dateStart,dateEnd):
        '''
        Makes sure that the dates are in the right format and that dateStart is <= dateEnd
        '''
        try:
            if datetime.datetime.strptime(dateStart, HRWSIRequest.DATE_FORMAT) > \
            datetime.datetime.strptime(dateEnd, HRWSIRequest.DATE_FORMAT):
                raise ValueError("-dateStart is after dateEnd!")

        except TypeError as err:
            logging.error(f"-dateStart or -dateEnd : {err} ")
            sys.exit(-2)
        except ValueError as err:
            logging.error(f"-dateStart or -dateEnd : {err} ")
            sys.exit(-2)

        return dateStart,dateEnd

    def validate_tile_format(self,tile_text):
        '''
        Makes sure that the tile are in the right format
        '''
        tile = None
        found = re.search(r'\d{2}'+ '[A-Z]{3}', tile_text)
        if found != None and ((len(tile_text) == 6 and tile_text[0]=="T") or (len(tile_text) == 5)):
            tile = found
        try:
            return tile.group(0)
        except:
            logging.error(f"-tile : {tile_text} as incorrect tile format, should be " + HRWSIRequest.TILE_FORMAT)
            sys.exit(-2)


    def validate_wkt_epsg(self,epsg_text,wkt_text):
        '''
        Makes sure that the epsg and wkt are in the right formats
        '''
        try:
            wkt_geo = gpd.GeoSeries.from_wkt([wkt_text],crs=epsg_text)
        except CRSError as e:
            logging.error(f"-epsg : {e}")
            sys.exit("-2")
        except GEOSException as e:
            logging.error(f"-wkt : {e}")
            sys.exit("-2")

        if wkt_geo.geom_type.item() not in ['MultiPolygon','Polygon']:
            logging.error(f"-wkt : only Polygon or MultiPolygon is accepted")
            sys.exit("-2")

        return epsg_text,wkt_text

    def validate_MGRS_file(self,mgrs_file):
        '''
        Makes sure that the MGRS file exists and is valid
        '''
        try:
            test_gpd = gpd.read_file(mgrs_file)
        except DataSourceError as err:
            logging.error(f"mgrs file : {err}")
            sys.exit("-2")
        except ValueError as err:
            logging.error(f"mgrs file : {err}")
            sys.exit("-2")
        except GEOSException as err:
            logging.error(f"mgrs file : {err}")
            sys.exit("-2")

        return mgrs_file


    def validate_layer(self,layer_file):
        '''
        Makes sure that the vector file exists and is valid
        '''
        try:
            test_gpd = gpd.read_file(layer_file)
        except DataSourceError as err:
            logging.error(f"-layer : {err}")
            sys.exit("-2")
        except ValueError as err:
            logging.error(f"-layer : {err}")
            sys.exit("-2")
        except GEOSException as err:
            logging.error(f"-layer : {err}")
            sys.exit("-2")

        test_wkt = str(test_gpd.union_all())
        test_epsg = test_gpd.crs.to_epsg()

        return self.validate_wkt_epsg(test_epsg,test_wkt)

    def get_hydro_year(self, dt):
        """Returns the hydrological year for a given datetime object."""
        # If the month is Sept (9) or later, the hydro year is the current year.
        # Otherwise, it is the previous year.
        if dt.month >= 9:
            return dt.year
        else:
            return dt.year - 1


    def set_query_file(self, query_file):
        self.query_file = query_file

    def set_client(self):
        '''
        access the catalogue for future data parsing/dowloading.
        response_checksum_validation="when_required" was added as a workaround to the bug 
        that spams checksum warnings since the beginning of this year (jan 2025):
        https://github.com/boto/botocore/issues/3382
        '''
        logging.info("Set S3 client to access bucket %s at %s."%(HRWSIRequest.BUCKET,HRWSIRequest.ENDPOINT_URL))
        self.s3_client = boto3.resource("s3",
                                 aws_access_key_id=HRWSIRequest.ACCESS_KEY,
                                 aws_secret_access_key=HRWSIRequest.SECRET_KEY,
                                 endpoint_url=HRWSIRequest.ENDPOINT_URL)

    def find_MGRS_tiles(self,epsg_text,wkt_text):
        tile_gpd = gpd.read_file(HRWSIRequest.MGRS_FILE)

        poly_gpd = gpd.GeoDataFrame(
            geometry=gpd.GeoSeries.from_wkt(
                [wkt_text],
                crs=epsg_text)).to_crs(tile_gpd.crs)

        tile_gpd['foundTiles']= tile_gpd.index
        intersecting = poly_gpd.sjoin(tile_gpd, how='inner')['foundTiles']
        found_tiles_gpd = tile_gpd[tile_gpd.foundTiles.isin(intersecting)]

        return found_tiles_gpd.Name.to_list()


    def build_query(self,
                        tiles=None,
                        wkt=None,
                        vector=None,
                        epsg=None,
                        productType=None,
                        dateStart=None,
                        dateEnd=None):
        '''
        pre-process the query paramaters before accessing the HR-WSI catalogue.
        :param tiles: Sentinel-2 MGRS tiles to search at, as string.
        :param wkt: well known text of a polygon or multipolygon.
        :param productType: product type, as string.
        :param dateStart: Min search date, as string.
        :param dateEnd: Max search date, as string.
        :param epsg: Projection system ID. Used with wkt.
        :param vector: vector file.
        '''

        self.request_params = {
            HRWSIRequest.TILES:None,
            HRWSIRequest.PRODUCT_TYPE:None,
            HRWSIRequest.START_DATE:None,
            HRWSIRequest.END_DATE:None,
            }

        if wkt:
            self.validate_MGRS_file(HRWSIRequest.MGRS_FILE)
            self.request_params[HRWSIRequest.TILES] = \
                self.find_MGRS_tiles(*self.validate_wkt_epsg(epsg,wkt))

        if vector:
            self.validate_MGRS_file(HRWSIRequest.MGRS_FILE)
            self.request_params[HRWSIRequest.TILES] = \
                self.find_MGRS_tiles(*self.validate_layer(vector))

        if tiles:
            self.request_params[HRWSIRequest.TILES] = \
                [self.validate_tile_format(tile).upper() for tile in tiles ]

        if len(self.request_params[HRWSIRequest.TILES]) == 0:
            logging.error("No tiles were identified")
            sys.exit(-2)
        else:
            self.request_params[HRWSIRequest.TILES] = \
            list(set(self.request_params[HRWSIRequest.TILES]))

        #search parameters
        self.request_params[HRWSIRequest.PRODUCT_TYPE] = \
        [self.validate_product_type(pT) for pT in productType]

        self.request_params[HRWSIRequest.START_DATE], self.request_params[HRWSIRequest.END_DATE] = \
        self.validate_dates(dateStart,dateEnd)

        logging.info("Query parameters: ")
        logging.info(self.request_params)

        return


    def execute_request(self):
        '''
        For each tile and each product type, parse the catalogue two times:
        first time: extract a list of all the available files starting at the start date (this will include the data after the end date)
        second time: extract a list of all the available files starting at the end date 
        the second list is then substracted from the first list, leaving only the data between the start and end dates.
        This fast method is possible because the products are apparently parsed by boto3 in the lexicographical order.  
        Generates a query_file.txt with a list of the found products (directories containing the layer files for each unique product).
        '''

        start_date = datetime.datetime.strptime(self.request_params[HRWSIRequest.START_DATE], HRWSIRequest.DATE_FORMAT).date()
        end_date = datetime.datetime.strptime(self.request_params[HRWSIRequest.END_DATE], HRWSIRequest.DATE_FORMAT).date()
        total_size_b = 0
        total_list_products = []
        logging.info("Search period : " + f"{start_date.strftime(HRWSIRequest.DATE_FORMAT)} - {end_date.strftime(HRWSIRequest.DATE_FORMAT)}")
        for pT in self.request_params[HRWSIRequest.PRODUCT_TYPE]:
            logging.info("    Looking for product type : " + pT)
            for tile in tqdm(self.request_params[HRWSIRequest.TILES]):
                #logging.info("        Looking for tile : " + tile)
                prefix = f"{pT}/{tile}"
                if pT in self.LIST_YEARLY:
				    #we calculate the starting and ending Hydrological Years
                    start_marker_HY = self.get_hydro_year(start_date)
                    end_marker_HY = self.get_hydro_year(end_date) + 1
                    marker_start = f"{prefix}/{start_marker_HY}"
                    marker_end = f"{prefix}/{end_marker_HY}"   
                else:
                    start_marker_date = start_date
                    end_marker_date = end_date + datetime.timedelta(days=1)
                    marker_start = f"{prefix}/{start_marker_date.year}/{start_marker_date.strftime('%m')}/{start_marker_date.strftime('%d')}"
                    marker_end = f"{prefix}/{end_marker_date.year}/{end_marker_date.strftime('%m')}/{end_marker_date.strftime('%d')}"
                contents_to_filter = [obj for obj in self.s3_client.Bucket(HRWSIRequest.BUCKET).objects.filter(Prefix = prefix,Marker=marker_start)]
                contents_filter = [obj for obj in self.s3_client.Bucket(HRWSIRequest.BUCKET).objects.filter(Prefix = prefix,Marker=marker_end)]
                contents = [item for item in contents_to_filter if item not in contents_filter]
                size_b = 0
                list_products = []
                for content in contents:
                    layer = content.key
                    size =int(content.size)
                    size_b+=size
                    product = os.path.dirname(layer)
                    if product not in list_products: list_products.append(product)
                total_size_b+=size_b  
                total_list_products.extend(list_products)
        logging.info(f"Total number of products found : {len(total_list_products)}" )
        if len(total_list_products) == 0:
                    logging.warning(f"            No product found for the entire query !")
        logging.info(f"Total size of products found (Mb): {round(total_size_b /1000000)}" )

        if len(total_list_products) > HRWSIRequest.DOWNLOAD_THRESHOLD:
            logging.warning(f"Warning: nb of products above the download threshold of {HRWSIRequest.DOWNLOAD_THRESHOLD}.")

        self.set_query_file(os.path.join(self.outputPath, f"query_file.txt"))
        logging.info("Listing query results in " + self.query_file)
        with open(self.query_file, 'w') as f:
            f.writelines([res+"\n" for res in total_list_products])
        return

    def download(self):
        '''
        tries to download all the products listed in query_file 
        '''

        # Check that the query file was set before the call
        if self.query_file is None:
            logging.error("No query_file was provided")
            sys.exit(-2)
        #====================
        # read query_file
        #====================
        try:
            with open(self.query_file) as f:
                content = f.readlines()
            product_list = [x.strip() for x in content if x.strip()]

        except :
            logging.error("Error while parsing query_file file: " + str(self.query_file))
            raise

        if len(product_list) > HRWSIRequest.DOWNLOAD_THRESHOLD:
            logging.error(f"Nb of products above the download threshold of {HRWSIRequest.DOWNLOAD_THRESHOLD}")
            raise

        # loop to download all products within the list
        logging.info(f"start downloading {len(product_list)} products")
        for info_product in tqdm(product_list):

            # start actual download
            self.download_from_s3(info_product)

    @retry(EndpointConnectionError, tries=3, delay=2)
    def download_from_s3(self, product_dir: str):
        '''
        function for downloading all the files (layers) of one product
        call s3 a first time to list the layers.
        call s3 for each layer to download
        '''

        err = None

        try:
            for obj in self.s3_client.Bucket(HRWSIRequest.BUCKET).objects.filter(Prefix = product_dir):
                obj_path = Path(os.path.join(self.outputPath,HRWSIRequest.RESULT_DIR,os.path.basename(product_dir),os.path.basename(obj.key)))
                obj_path.parent.mkdir(parents=True, exist_ok=True)
                self.s3_client.Bucket(HRWSIRequest.BUCKET).download_file(obj.key, obj_path)

        except ClientError as err:
            if err  == "404":
                raise RuntimeError(f"The file does not exists: {err}") from err
            elif err.response['Error']['Code'] == "403":
                raise RuntimeError(f"Access denied. Check your permissions : {err}") from err
            elif err.response['Error']['Code'] == "503":
                raise RuntimeError(f"S3 503 error (Service Unavailable): {err}") from err
            else:
                raise RuntimeError(f"Unexpected error : {err}") from err
        except EndpointConnectionError as err:
            raise RuntimeError(f"Error checking file existence: {err}") from err
        except FileNotFoundError as err:
            raise RuntimeError(f"File not found: {err}") from err

        finally:
            if err and err.response['Error']['Code'] == "404":
                sys.exit(12)
            if err and err.response['Error']['Code'] == "403":
                sys.exit(78)
            if err and err.response['Error']['Code'] != "503":
                sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="""This script provides query and download capabilities for the HR-WSI products, there are three possible modes of execution (query|query_and_download|download) and three possible mode of selection (tiles|wkt|vector), see example usages below:\n
    > python s3_hrwsi_downloader.py output_folder -query -productType FSC WIC_S2 -tiles T31TCH T30TYN -dateStart 2025-02-01 -dateEnd 2025-02-15\n
    > python s3_hrwsi_downloader.py output_folder -query_and_download -productType GFSC -wkt "POLYGON ((704922.894694 4756709.422481, 920001.318865 4729607.8903, 704922.894694 4756709.422481))" -epsg 32630 -dateStart 2025-02-01 -dateEnd 2025-02-15\n
    > python s3_hrwsi_downloader.py output_folder -query_and_download -productType SWS -vector path/to/vector/file.shp -dateStart 2025-02-15 -dateEnd 2025-03-15\n
    > python s3_hrwsi_downloader.py output_folder -download -query_file output_folder/query_file.txt\n""", formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("output_dir", help="output directory to store HR-WSI products")

    # Exclusive modes available
    group_mode = parser.add_argument_group("execution mode")
    group_mode_ex = group_mode.add_mutually_exclusive_group(required=True)
    group_mode_ex.add_argument("-query", dest='query', action='store_true', help="only query and list the corresponding HR-WSI products found, the list of found products is written in a query_file.txt file in output_dir.")
    group_mode_ex.add_argument("-query_and_download", dest='query_and_download', action='store_true', help="query and download the corresponding HR-WSI products found, the list of found products is written in a query_file.txt and the found HR-WSI products are downloaded in output_dir.")
    group_mode_ex.add_argument("-download", dest='download', action='store_true', help="only download HR-WSI products listed in the file given with -query_file. The found HR-WSI products are downloaded in output_dir.")

    #exclusive spatial parameters input
    group_mode_s = parser.add_argument_group("selection mode")
    group_mode_sel = group_mode_s.add_mutually_exclusive_group()
    group_mode_sel.add_argument("-tiles", type=str, nargs='+', help="one or more tile identifier defining the products locations on the Military Grid Reference System (MGRS) grid used for Sentinel-2 products. Format T##XXX or ##XXX. Example: T31TCH 28WET")
    group_mode_sel.add_argument("-vector", type=str, help="Vector file containing 2D vector layers (polygon or multipolygon). can be .shp, .geojson, .gpkg, .kml. Must include a projection system.")
    group_mode_sel.add_argument("-wkt",type=str,help="Well Known Text (between \"\") describing either a polygon ( ex: \"POLYGON ((1 1,5 1,5 5,1 5,1 1))\" ) or a multi polygon (ex: \"MULTIPOLYGON (((1 1,5 1,5 5,1 5,1 1),(2 2,2 3,3 3,3 2,2 2)),((6 3,9 2,9 4,6 3)))\" )")

    # Parameters used to define a query, to use a query generated through the HR-WSI finder or to build a new one
    group_query = parser.add_argument_group("query_params", "mandatory parameters for query and query_and_download modes")
    group_query.add_argument("-epsg", type=str, help="Projection system ID. Mandatory if -wkt given. ex: 4326 or 32631")
    group_query.add_argument("-productType", type=str, nargs='+', help="One or more product type (separated by spaces) among FSC|SWS|GFSC|WDS|WIC_S1|WIC_S2|WIC_S1S2|CC|SP_S2|SP_S1S2|ICD|WCD")
    group_query.add_argument("-dateStart", type=str, help="start date of the search window. Observation date. Format YYYY-MM-DD.")
    group_query.add_argument("-dateEnd", type=str, help="end date of the search window. Observation date. Format YYYY-MM-DD.")

    # Parameter to download products found with last query
    group_download = parser.add_argument_group("download_params", "mandatory parameters for query_and_download or download modes")
    group_download.add_argument("-query_file", type=str, \
        help="takes a .txt file containing a list of HR-WSI products to download. Path in the format productType/tile(minus the 'T')/year/month/day/product_name")

    args = parser.parse_args()

    # check input arguments
    if args.query or args.query_and_download:
        if not args.dateStart:
            parser.error("-query and -query_and_download require -dateStart")
        if not args.dateEnd:
            parser.error("-query and -query_and_download require -dateEnd")
        if not args.productType:
            parser.error("-query and -query_and_download require -productType")
        if not args.tiles and not args.wkt and not args.vector:
            parser.error("-query and -query_and_download require either -tiles, -vector or -wkt")
        if args.wkt and not args.epsg:
            parser.error("-wkt requires -epsg")
        if args.epsg and not args.wkt:
            parser.error("-epsg requires -wkt")
        if args.query_file:
            parser.error("-query_file can only be given with -download")

    if args.download :
        if not args.query_file:
            parser.error("-download requires -query_file")
        if args.dateStart or args.dateEnd or args.productType or args.tiles or args.vector or args.wkt or args.epsg:
            parser.error("-download only allows for -query_file and the output path to be given")

    # Init Request
    hrwsi = HRWSIRequest(args.output_dir)
    hrwsi.set_client()

    # run request to search for products
    if args.query or args.query_and_download:

        hrwsi.build_query(tiles=args.tiles,
                            wkt=args.wkt,
                            epsg=args.epsg,
                            vector=args.vector,
                            productType=args.productType,
                            dateStart=args.dateStart,
                            dateEnd=args.dateEnd)
        hrwsi.execute_request()

    # load the query file if not generated in this run
    if args.download:
        hrwsi.set_query_file(args.query_file)

    # download products
    if args.query_and_download or args.download:
        logging.info("Start downloading...")
        hrwsi.download()
        logging.info("Downloading complete!")
        logging.info("Downloaded products are in " + os.path.join(hrwsi.outputPath, hrwsi.RESULT_DIR))
    else:
        logging.info("No products were downloaded.")

    logging.info("End.")


if __name__ == "__main__":
    # Set logging level and format.
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format= \
        '%(asctime)s - %(filename)s:%(lineno)s - %(levelname)s - %(message)s')
    main()
